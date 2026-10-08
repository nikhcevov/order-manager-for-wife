import { execFileSync } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';

const required = name => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const commitPattern = /^[0-9a-f]{40}$/;
const tagPattern = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const versionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
async function packageVersion() {
  const { version } = JSON.parse(await readFile('package.json', 'utf8'));
  if (typeof version !== 'string' || !versionPattern.test(version) || !tagPattern.test(`v${version}`)) {
    throw new Error('package.json version must be stable MAJOR.MINOR.PATCH');
  }
  return version;
}
function versionTags(version) {
  const [major, minor] = version.split('.');
  return [version, `${major}.${minor}`, major];
}
function validateReleaseTag(tag, version) {
  if (tag !== `v${version}`) throw new Error(`Git tag must match package.json version v${version}`);
}
function versionChanged(version) {
  const parent = run('git', ['rev-list', '--parents', '-n', '1', 'HEAD']).split(' ')[1];
  if (!parent || !run('git', ['ls-tree', '--name-only', parent, '--', 'package.json'])) return true;
  return JSON.parse(run('git', ['show', `${parent}:package.json`])).version !== version;
}
function deliveryTag(ref, version) {
  if (ref === 'refs/heads/main') return 'main';
  if (!ref.startsWith('refs/tags/')) return null;
  const tag = ref.slice('refs/tags/'.length);
  validateReleaseTag(tag, version);
  return tag;
}
function repository() {
  const repo = required('GITHUB_REPOSITORY');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('Invalid GITHUB_REPOSITORY');
  return repo;
}
function run(binary, args) {
  try { return execFileSync(binary, args, { encoding: 'utf8', timeout: 300_000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch { throw new Error(`${binary} ${args[0]} failed`); }
}
async function emit(result) {
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, Object.entries(result).map(([key, value]) => `${key}=${value}\n`).join(''));
  }
  console.log(JSON.stringify(result));
}
async function resolve() {
  const event = JSON.parse(await readFile(required('GITHUB_EVENT_PATH'), 'utf8'));
  const image = `ghcr.io/${repository().toLowerCase()}`;
  const commit = run('git', ['rev-parse', 'HEAD']);
  if (!commitPattern.test(commit)) throw new Error('HEAD is not a full source commit');
  const version = await packageVersion();
  const eventName = required('GITHUB_EVENT_NAME');
  const eligibleEvent = ['push', 'workflow_dispatch'].includes(eventName) && event.deleted !== true;
  const tag = eligibleEvent ? deliveryTag(required('GITHUB_REF'), version) : null;
  const releasing = tag !== null && (tag !== 'main' || versionChanged(version));
  const tags = [...(releasing ? versionTags(version) : []), ...(tag === 'main' ? ['main', 'latest'] : [])];
  await emit({
    image, commit, version, tag: tag ?? '', releaseTag: releasing ? `v${version}` : '',
    tags: JSON.stringify(tags), candidate: `order-manager-candidate:sha-${commit}`, eligible: tag !== null
  });
}
function githubClient() {
  const token = required('GITHUB_TOKEN');
  const repo = repository();
  const base = new URL(process.env.GITHUB_API_URL ?? 'https://api.github.com');
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) {
    throw new Error('GITHUB_API_URL must use HTTPS or a loopback fixture');
  }
  const repoPath = `/repos/${repo.split('/').map(encodeURIComponent).join('/')}`;
  async function request(path, { method = 'GET', body, allowMissing = false } = {}) {
    const response = await fetch(`${base.href.replace(/\/$/, '')}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error', signal: AbortSignal.timeout(30_000)
    });
    if (allowMissing && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub API request failed (HTTP ${response.status})`);
    return response.json();
  }
  return { repoPath, request };
}
async function refCommit(client, ref) {
  const { repoPath, request } = client;
  const current = await request(`${repoPath}/git/ref/${ref.slice('refs/'.length).split('/').map(encodeURIComponent).join('/')}`, { allowMissing: true });
  if (current === null) return null;
  let object = current.object;
  const visited = new Set();
  while (object?.type === 'tag') {
    if (!commitPattern.test(object.sha) || visited.has(object.sha) || visited.size >= 32) throw new Error('Invalid annotated-tag chain');
    visited.add(object.sha);
    object = (await request(`${repoPath}/git/tags/${object.sha}`)).object;
  }
  if (object?.type !== 'commit' || !commitPattern.test(object.sha)) throw new Error('Reference did not resolve to a commit');
  return object.sha;
}
function sourceCommit() {
  const source = required('SOURCE_COMMIT');
  if (!commitPattern.test(source)) throw new Error('Invalid SOURCE_COMMIT');
  return source;
}
async function checkReleaseTarget(client, tag, source) {
  const existing = await refCommit(client, `refs/tags/${tag}`);
  if (existing !== null && existing !== source) throw new Error(`Release tag ${tag} already identifies another commit; bump the version`);
  return existing;
}
async function eligible() {
  const version = await packageVersion();
  const source = sourceCommit();
  const ref = required('GITHUB_REF');
  if (deliveryTag(ref, version) === null) return emit({ eligible: false });
  const client = githubClient();
  // A private repository's authorization failure also looks like 404. Prove access first.
  await client.request(client.repoPath);
  if (await refCommit(client, ref) !== source) return emit({ eligible: false });
  const releaseTag = process.env.RELEASE_TAG;
  if (releaseTag) {
    validateReleaseTag(releaseTag, version);
    await checkReleaseTarget(client, releaseTag, source);
  }
  await emit({ eligible: true });
}
function imageRepository() {
  const image = required('IMAGE');
  if (!/^(?:[a-z0-9.-]+(?::[0-9]+)?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/.test(image)) throw new Error('IMAGE must be an untagged image repository');
  return image;
}
async function release() {
  const version = await packageVersion();
  const tag = required('RELEASE_TAG');
  validateReleaseTag(tag, version);
  const source = sourceCommit();
  const image = imageRepository();
  const digest = required('IMAGE_DIGEST');
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error('Invalid IMAGE_DIGEST');
  const client = githubClient();
  const { repoPath, request } = client;
  await request(repoPath);
  if (await checkReleaseTarget(client, tag, source) === null) {
    const annotated = await request(`${repoPath}/git/tags`, {
      method: 'POST', body: { tag, message: `Release ${tag}`, object: source, type: 'commit' }
    });
    if (!commitPattern.test(annotated.sha)) throw new Error('GitHub returned an invalid annotated tag');
    await request(`${repoPath}/git/refs`, { method: 'POST', body: { ref: `refs/tags/${tag}`, sha: annotated.sha } });
  }
  let published = await request(`${repoPath}/releases/tags/${encodeURIComponent(tag)}`, { allowMissing: true });
  if (published === null) {
    published = await request(`${repoPath}/releases`, {
      method: 'POST',
      body: {
        tag_name: tag, target_commitish: source, name: `Release ${tag}`, generate_release_notes: true,
        body: `Docker image: \`${image}:${version}\`\n\nVerified digest: \`${image}@${digest}\`\n\nSource commit: \`${source}\``
      }
    });
  }
  await emit({ releaseTag: tag, commit: source, url: published.html_url });
}
async function push() {
  const image = imageRepository();
  const commit = sourceCommit();
  const version = required('IMAGE_VERSION');
  if (!versionPattern.test(version)) throw new Error('Invalid IMAGE_VERSION');
  const tags = JSON.parse(required('DELIVERY_TAGS'));
  const allowed = new Set([...versionTags(version), 'main', 'latest']);
  if (!Array.isArray(tags) || tags.length === 0 || new Set(tags).size !== tags.length ||
      tags.some(tag => typeof tag !== 'string' || !tagPattern.test(tag) || !allowed.has(tag))) {
    throw new Error('Invalid DELIVERY_TAGS');
  }
  const candidate = required('CANDIDATE_IMAGE');
  const inspected = JSON.parse(run('docker', ['image', 'inspect', candidate]))[0];
  if (inspected.Config.Labels?.['org.opencontainers.image.revision'] !== commit) throw new Error('Candidate source label does not match SOURCE_COMMIT');
  if (inspected.Config.Labels?.['org.opencontainers.image.version'] !== version) throw new Error('Candidate version label does not match IMAGE_VERSION');
  const digests = [];
  for (const tag of [`sha-${commit}`, ...tags]) {
    const reference = `${image}:${tag}`;
    run('docker', ['tag', inspected.Id, reference]);
    const output = run('docker', ['push', reference]);
    const digest = /digest: (sha256:[0-9a-f]{64})\b/.exec(output)?.[1];
    if (!digest) throw new Error('Registry push returned no digest evidence');
    digests.push(digest);
  }
  if (digests.some(digest => digest !== digests[0])) throw new Error('Published references have different digests');
  await emit({ image, commit, version, tags, digest: digests[0], candidateId: inspected.Id });
}
try {
  const commands = { resolve, eligible, push, release };
  const command = commands[process.argv[2]];
  if (!command) throw new Error('Usage: node scripts/publish-image.mjs resolve|eligible|push|release');
  await command();
} catch (error) {
  // Do not print API response bodies, subprocess environments, or registry credentials.
  console.error(error instanceof Error ? error.message : 'Publication failed');
  process.exitCode = 1;
}
