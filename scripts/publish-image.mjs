import { execFileSync } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';

const required = name => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const commitPattern = /^[0-9a-f]{40}$/;
const tagPattern = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
function deliveryTag(ref) {
  if (ref === 'refs/heads/main') return 'main';
  if (!ref.startsWith('refs/tags/')) return null;
  const tag = ref.slice('refs/tags/'.length);
  if (!tagPattern.test(tag) || tag === 'main' || tag.startsWith('sha-')) {
    throw new Error(`Unsupported or reserved Git tag: ${JSON.stringify(tag)}`);
  }
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
  const eligibleEvent = required('GITHUB_EVENT_NAME') === 'push' && event.deleted !== true;
  const tag = eligibleEvent ? deliveryTag(required('GITHUB_REF')) : null;
  await emit({ image, commit, tag: tag ?? '', candidate: `order-manager-candidate:sha-${commit}`, eligible: tag !== null });
}
async function eligible() {
  const token = required('GITHUB_TOKEN');
  const repo = repository();
  const source = required('SOURCE_COMMIT');
  if (!commitPattern.test(source)) throw new Error('Invalid SOURCE_COMMIT');
  const ref = required('GITHUB_REF');
  if (deliveryTag(ref) === null) return emit({ eligible: false });
  const base = new URL(process.env.GITHUB_API_URL ?? 'https://api.github.com');
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) {
    throw new Error('GITHUB_API_URL must use HTTPS or a loopback fixture');
  }
  async function get(path, allowMissing = false) {
    const response = await fetch(`${base.href.replace(/\/$/, '')}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      redirect: 'error', signal: AbortSignal.timeout(30_000)
    });
    if (allowMissing && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub lookup failed (HTTP ${response.status})`);
    return response.json();
  }
  const repoPath = `/repos/${repo.split('/').map(encodeURIComponent).join('/')}`;
  // A private repository's authorization failure also looks like 404. Prove access first.
  await get(repoPath);
  const current = await get(`${repoPath}/git/ref/${ref.slice('refs/'.length).split('/').map(encodeURIComponent).join('/')}`, true);
  if (current === null) return emit({ eligible: false });
  let object = current.object;
  const visited = new Set();
  while (object?.type === 'tag') {
    if (!commitPattern.test(object.sha) || visited.has(object.sha) || visited.size >= 32) throw new Error('Invalid annotated-tag chain');
    visited.add(object.sha);
    object = (await get(`${repoPath}/git/tags/${object.sha}`)).object;
  }
  if (object?.type !== 'commit' || !commitPattern.test(object.sha)) throw new Error('Reference did not resolve to a commit');
  await emit({ eligible: object.sha === source });
}
async function push() {
  const image = required('IMAGE');
  if (!/^(?:[a-z0-9.-]+(?::[0-9]+)?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/.test(image)) throw new Error('IMAGE must be an untagged image repository');
  const commit = required('SOURCE_COMMIT');
  if (!commitPattern.test(commit)) throw new Error('Invalid SOURCE_COMMIT');
  const tag = required('DELIVERY_TAG');
  if (!tagPattern.test(tag) || tag.startsWith('sha-')) throw new Error('Invalid DELIVERY_TAG');
  const candidate = required('CANDIDATE_IMAGE');
  const inspected = JSON.parse(run('docker', ['image', 'inspect', candidate]))[0];
  if (inspected.Config.Labels?.['org.opencontainers.image.revision'] !== commit) throw new Error('Candidate source label does not match SOURCE_COMMIT');
  const digests = [];
  for (const reference of [`${image}:sha-${commit}`, `${image}:${tag}`]) {
    run('docker', ['tag', inspected.Id, reference]);
    const output = run('docker', ['push', reference]);
    const digest = /digest: (sha256:[0-9a-f]{64})\b/.exec(output)?.[1];
    if (!digest) throw new Error('Registry push returned no digest evidence');
    digests.push(digest);
  }
  if (digests[0] !== digests[1]) throw new Error('Published references have different digests');
  await emit({ image, commit, tag, digest: digests[0], candidateId: inspected.Id });
}
try {
  const commands = { resolve, eligible, push };
  const command = commands[process.argv[2]];
  if (!command) throw new Error('Usage: node scripts/publish-image.mjs resolve|eligible|push');
  await command();
} catch (error) {
  // Do not print API response bodies, subprocess environments, or registry credentials.
  console.error(error instanceof Error ? error.message : 'Publication failed');
  process.exitCode = 1;
}
