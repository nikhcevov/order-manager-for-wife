import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../publish-image.mjs', import.meta.url));
const repository = 'Fixture/Publisher';
const image = 'ghcr.io/fixture/publisher';
const version = '1.2.3';
const releaseTag = `v${version}`;
const token = 'synthetic-publication-test-token';
const digest = `sha256:${'c'.repeat(64)}`;
const otherCommit = 'd'.repeat(40);

function isolatedEnvironment(overrides = {}) {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name.startsWith('GITHUB_') || name.startsWith('GIT_') || [
      'SOURCE_COMMIT', 'RELEASE_TAG', 'IMAGE', 'IMAGE_DIGEST', 'IMAGE_VERSION',
      'DELIVERY_TAG', 'DELIVERY_TAGS', 'CANDIDATE_IMAGE',
    ].includes(name)) delete environment[name];
  }
  return {
    ...environment,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    ...overrides,
  };
}

function git(cwd, ...args) {
  const result = spawnSync('git', [
    '-c', 'user.useConfigOnly=true',
    '-c', 'commit.gpgsign=false',
    '-c', 'tag.gpgsign=false',
    ...args,
  ], { cwd, env: isolatedEnvironment(), encoding: 'utf8' });
  assert.equal(result.error, undefined, 'Git fixture setup must start');
  assert.equal(result.status, 0, `Git fixture setup failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function createRepo(t, options = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'publish-image-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  git(cwd, 'init', '--initial-branch=main');
  git(cwd, 'config', '--local', 'user.name', 'Publication Fixture');
  git(cwd, 'config', '--local', 'user.email', 'publication-fixture@example.invalid');
  const packagePath = join(cwd, 'package.json');
  const commitPackage = async (value, message) => {
    const pkg = { name: 'independent-publication-fixture', private: true };
    if (value !== undefined) pkg.version = value;
    await writeFile(packagePath, `${JSON.stringify(pkg)}\n`);
    git(cwd, 'add', 'package.json');
    git(cwd, 'commit', '--allow-empty', '-m', message);
  };
  if (!options.initial) {
    await commitPackage(Object.hasOwn(options, 'previousVersion') ? options.previousVersion : version, 'Previous application state');
  }
  await commitPackage(Object.hasOwn(options, 'version') ? options.version : version, 'Source application state');
  return { cwd, commit: git(cwd, 'rev-parse', 'HEAD') };
}

async function invoke(repo, command, environment = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, command], {
      cwd: repo.cwd,
      env: isolatedEnvironment(environment),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function successful(result) {
  assert.equal(result.signal, null, 'CLI must finish without being killed');
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

function failed(result) {
  assert.equal(result.signal, null, 'CLI must reject without timing out');
  assert.notEqual(result.code, 0, 'CLI unexpectedly succeeded');
  assert.equal(result.stdout.trim(), '', 'Rejected command must not emit success outputs');
}

async function resolveEvent(repo, event = {}, ref = 'refs/heads/main', eventName = 'push') {
  const eventPath = join(repo.cwd, 'event.json');
  const outputPath = join(repo.cwd, 'github-output');
  await writeFile(eventPath, JSON.stringify(event));
  await writeFile(outputPath, '');
  const result = await invoke(repo, 'resolve', {
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_EVENT_NAME: eventName,
    GITHUB_REF: ref,
    GITHUB_REPOSITORY: repository,
    GITHUB_OUTPUT: outputPath,
  });
  return { ...result, outputs: await readFile(outputPath, 'utf8') };
}

function assertResolution(result, repo, expected) {
  const resolved = successful(result);
  assert.deepEqual(resolved, {
    image,
    commit: repo.commit,
    candidate: `order-manager-candidate:sha-${repo.commit}`,
    version: expected.version ?? version,
    tag: expected.tag,
    releaseTag: expected.releaseTag,
    tags: JSON.stringify(expected.tags),
    eligible: expected.eligible,
  });
}

for (const [name, options, aliases, release] of [
  ['ordinary main push', {}, ['main', 'latest'], ''],
  ['patch version bump', { previousVersion: '1.2.2' }, ['1.2.3', '1.2', '1', 'main', 'latest'], releaseTag],
  ['minor version bump', { previousVersion: '1.1.9', version: '1.2.0' }, ['1.2.0', '1.2', '1', 'main', 'latest'], 'v1.2.0'],
  ['major version bump', { previousVersion: '0.9.9', version: '1.0.0' }, ['1.0.0', '1.0', '1', 'main', 'latest'], 'v1.0.0'],
  ['initial version introduction', { previousVersion: undefined }, ['1.2.3', '1.2', '1', 'main', 'latest'], releaseTag],
  ['initial versioned commit', { initial: true }, ['1.2.3', '1.2', '1', 'main', 'latest'], releaseTag],
  ['stable zero-major release', { previousVersion: undefined, version: '0.1.0' }, ['0.1.0', '0.1', '0', 'main', 'latest'], 'v0.1.0'],
]) {
  test(`resolve: ${name} has exact delivery and release policy`, async t => {
    const repo = await createRepo(t, options);
    assertResolution(await resolveEvent(repo), repo, {
      version: options.version ?? version,
      tag: 'main', releaseTag: release, tags: aliases, eligible: true,
    });
  });
}

test('resolve: exact manual version tag excludes main and latest', async t => {
  const repo = await createRepo(t);
  git(repo.cwd, 'tag', '-a', releaseTag, '-m', 'Manual release');
  assertResolution(await resolveEvent(repo, {}, `refs/tags/${releaseTag}`), repo, {
    tag: releaseTag, releaseTag, tags: ['1.2.3', '1.2', '1'], eligible: true,
  });
});

test('resolve: dispatched main release has the same stable aliases as a bump push', async t => {
  const repo = await createRepo(t, { previousVersion: '1.2.2' });
  assertResolution(await resolveEvent(repo, {}, 'refs/heads/main', 'workflow_dispatch'), repo, {
    tag: 'main', releaseTag, tags: ['1.2.3', '1.2', '1', 'main', 'latest'], eligible: true,
  });
});

test('resolve: dispatched matching stable tag excludes main and latest', async t => {
  const repo = await createRepo(t);
  git(repo.cwd, 'tag', '-a', releaseTag, '-m', 'Dispatched manual release');
  assertResolution(await resolveEvent(repo, {}, `refs/tags/${releaseTag}`, 'workflow_dispatch'), repo, {
    tag: releaseTag, releaseTag, tags: ['1.2.3', '1.2', '1'], eligible: true,
  });
});

for (const tag of ['v1.2.4', 'v1.2', 'release-1.2.3', 'v1.2.3-rc.1', 'v1.2.3+build.1']) {
  test(`resolve: rejects mismatched or unsupported tag ${tag}`, async t => {
    const repo = await createRepo(t);
    const result = await resolveEvent(repo, {}, `refs/tags/${tag}`);
    failed(result);
    assert.equal(result.outputs, '', 'Invalid tag must fail before writing GitHub outputs');
  });
}

for (const invalid of [undefined, '1.2', '01.2.3', '1.2.3-rc.1', '1.2.3+build.1', 123]) {
  test(`resolve: rejects invalid or nonstable root version ${JSON.stringify(invalid)}`, async t => {
    const repo = await createRepo(t, { version: invalid });
    const result = await resolveEvent(repo);
    failed(result);
    assert.equal(result.outputs, '', 'Invalid version must fail before writing GitHub outputs');
  });
}

for (const [name, event, ref, eventName] of [
  ['deleted push', { deleted: true }, 'refs/tags/v1.2.3', 'push'],
  ['unrelated branch', {}, 'refs/heads/feature', 'push'],
  ['unsupported event', {}, 'refs/heads/main', 'pull_request'],
]) {
  test(`resolve: ${name} has no delivery or release aliases`, async t => {
    const repo = await createRepo(t, { previousVersion: '1.2.2' });
    assertResolution(await resolveEvent(repo, event, ref, eventName), repo, {
      tag: '', releaseTag: '', tags: [], eligible: false,
    });
  });
}

async function githubFixture(t, options = {}) {
  const prefix = `/repos/${repository}`;
  const refs = new Map();
  const tags = new Map();
  const releases = new Map();
  const requests = [];
  const violations = [];
  const failures = new Map();
  let nextReleaseId = 1;
  const storeTag = (name, commit) => {
    const sha = createHash('sha1').update(`${name}:${commit}`).digest('hex');
    tags.set(sha, { sha, tag: name, object: { type: 'commit', sha: commit } });
    refs.set(`tags/${name}`, { ref: `refs/tags/${name}`, object: { type: 'tag', sha } });
    return sha;
  };
  const peel = name => {
    let object = refs.get(name)?.object;
    const seen = new Set();
    while (object?.type === 'tag') {
      assert.ok(!seen.has(object.sha), 'Fixture must not store cyclic tags');
      seen.add(object.sha);
      object = tags.get(object.sha)?.object;
    }
    return object?.type === 'commit' ? object.sha : undefined;
  };
  const server = createServer(async (request, response) => {
    const send = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    try {
      const path = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const rawBody = Buffer.concat(chunks).toString('utf8');
      const body = rawBody ? JSON.parse(rawBody) : undefined;
      requests.push({ method: request.method, path, body, authorization: request.headers.authorization });
      if (request.headers.authorization !== `Bearer ${token}`) {
        violations.push('Unauthenticated GitHub request');
        return send(401, { message: 'Bad credentials' });
      }
      const failure = failures.get(`${request.method} ${path}`);
      if (failure) return send(failure, { message: 'Synthetic API failure' });
      if (request.method === 'GET' && path === prefix) return send(200, { full_name: repository });
      if (request.method === 'GET' && path.startsWith(`${prefix}/git/ref/`)) {
        const ref = refs.get(path.slice(`${prefix}/git/ref/`.length));
        return send(ref ? 200 : 404, ref ?? { message: 'Not Found' });
      }
      if (request.method === 'GET' && path.startsWith(`${prefix}/git/tags/`)) {
        const tag = tags.get(path.slice(`${prefix}/git/tags/`.length));
        return send(tag ? 200 : 404, tag ?? { message: 'Not Found' });
      }
      if (request.method === 'POST' && path === `${prefix}/git/tags`) {
        if (body.type !== 'commit' || !/^[0-9a-f]{40}$/.test(body.object) || typeof body.message !== 'string' || !body.message.trim()) {
          violations.push('Invalid annotated tag object');
          return send(422, { message: 'Invalid tag' });
        }
        const sha = createHash('sha1').update(JSON.stringify(body)).digest('hex');
        const tag = { sha, tag: body.tag, message: body.message, object: { type: body.type, sha: body.object } };
        tags.set(sha, tag);
        return send(201, tag);
      }
      if (request.method === 'POST' && path === `${prefix}/git/refs`) {
        const name = body.ref?.replace(/^refs\//, '');
        if (!name?.startsWith('tags/') || !tags.has(body.sha) || refs.has(name)) {
          violations.push('Invalid or duplicate tag ref creation');
          return send(422, { message: 'Invalid ref' });
        }
        const ref = { ref: body.ref, object: { type: 'tag', sha: body.sha } };
        refs.set(name, ref);
        return send(201, ref);
      }
      if (request.method === 'GET' && path.startsWith(`${prefix}/releases/tags/`)) {
        const release = releases.get(path.slice(`${prefix}/releases/tags/`.length));
        return send(release ? 200 : 404, release ?? { message: 'Not Found' });
      }
      if (request.method === 'POST' && path === `${prefix}/releases`) {
        if (releases.has(body.tag_name) || peel(`tags/${body.tag_name}`) !== body.target_commitish || body.generate_release_notes !== true) {
          violations.push('Release did not reference its stored exact source tag with generated notes');
          return send(422, { message: 'Invalid release' });
        }
        const release = {
          ...body,
          draft: body.draft ?? false,
          prerelease: body.prerelease ?? false,
          id: nextReleaseId++,
          html_url: `https://github.com/${repository}/releases/tag/${body.tag_name}`,
        };
        releases.set(body.tag_name, release);
        return send(201, release);
      }
      violations.push(`Unexpected API request: ${request.method} ${path}`);
      send(404, { message: 'Unknown fixture route' });
    } catch (error) {
      violations.push(error.message);
      send(500, { message: 'Fixture failure' });
    }
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    assert.deepEqual(violations, [], 'CLI must obey the authenticated GitHub fixture contract');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  if (options.mainCommit) refs.set('heads/main', { ref: 'refs/heads/main', object: { type: 'commit', sha: options.mainCommit } });
  const api = `http://127.0.0.1:${server.address().port}`;
  return {
    refs, tags, releases, requests, failures, storeTag, peel, prefix,
    environment: {
      GITHUB_TOKEN: token,
      GITHUB_REPOSITORY: repository,
      GITHUB_API_URL: api,
    },
  };
}

function apiEnvironment(repo, fixture, overrides = {}) {
  return {
    ...fixture.environment,
    SOURCE_COMMIT: repo.commit,
    GITHUB_REF: 'refs/heads/main',
    RELEASE_TAG: releaseTag,
    IMAGE: image,
    IMAGE_DIGEST: digest,
    ...overrides,
  };
}

function mutations(fixture) {
  return fixture.requests.filter(request => request.method !== 'GET');
}

function assertStoredRelease(fixture, repo) {
  assert.equal(fixture.peel(`tags/${releaseTag}`), repo.commit);
  assert.equal(fixture.refs.get(`tags/${releaseTag}`).object.type, 'tag', 'Release ref must be annotated');
  assert.equal(fixture.releases.size, 1);
  const release = fixture.releases.get(releaseTag);
  assert.equal(release.tag_name, releaseTag);
  assert.equal(release.target_commitish, repo.commit);
  assert.equal(release.generate_release_notes, true);
  assert.equal(release.draft, false);
  assert.equal(release.prerelease, false);
}

test('eligible: authenticated current main commit permits publication without mutation', async t => {
  const repo = await createRepo(t);
  const fixture = await githubFixture(t, { mainCommit: repo.commit });
  const result = successful(await invoke(repo, 'eligible', apiEnvironment(repo, fixture, { RELEASE_TAG: '' })));
  assert.deepEqual(result, { eligible: true });
  assert.equal(fixture.requests[0].path, fixture.prefix, 'Repository authorization must precede ref lookups');
  assert.deepEqual(mutations(fixture), []);
});

for (const [name, mainCommit] of [['superseded head', otherCommit], ['deleted ref', undefined]]) {
  test(`eligible: ${name} skips publication`, async t => {
    const repo = await createRepo(t);
    const fixture = await githubFixture(t, { mainCommit });
    assert.deepEqual(successful(await invoke(repo, 'eligible', apiEnvironment(repo, fixture))), { eligible: false });
    assert.deepEqual(mutations(fixture), []);
  });
}

test('eligible: existing release annotated tag at another commit fails before publication', async t => {
  const repo = await createRepo(t);
  const fixture = await githubFixture(t, { mainCommit: repo.commit });
  fixture.storeTag(releaseTag, otherCommit);
  failed(await invoke(repo, 'eligible', apiEnvironment(repo, fixture)));
  assert.equal(fixture.peel(`tags/${releaseTag}`), otherCommit);
  assert.equal(fixture.releases.size, 0);
  assert.deepEqual(mutations(fixture), []);
});

test('eligible: manual annotated tag peels to the authenticated source commit', async t => {
  const repo = await createRepo(t);
  const fixture = await githubFixture(t);
  fixture.storeTag(releaseTag, repo.commit);
  assert.deepEqual(successful(await invoke(repo, 'eligible', apiEnvironment(repo, fixture, {
    GITHUB_REF: `refs/tags/${releaseTag}`,
  }))), { eligible: true });
  assert.equal(fixture.peel(`tags/${releaseTag}`), repo.commit);
  assert.deepEqual(mutations(fixture), []);
});

test('eligible: a matching existing release tag permits a main retry without mutation', async t => {
  const repo = await createRepo(t);
  const fixture = await githubFixture(t, { mainCommit: repo.commit });
  fixture.storeTag(releaseTag, repo.commit);
  assert.deepEqual(successful(await invoke(repo, 'eligible', apiEnvironment(repo, fixture))), { eligible: true });
  assert.equal(fixture.peel(`tags/${releaseTag}`), repo.commit);
  assert.deepEqual(mutations(fixture), []);
});

test('eligible: failed current-ref lookup is fatal rather than a superseded-head skip', async t => {
  const repo = await createRepo(t);
  const fixture = await githubFixture(t, { mainCommit: repo.commit });
  fixture.failures.set(`GET ${fixture.prefix}/git/ref/heads/main`, 503);
  failed(await invoke(repo, 'eligible', apiEnvironment(repo, fixture)));
  assert.equal(fixture.refs.get('heads/main').object.sha, repo.commit);
  assert.deepEqual(mutations(fixture), []);
});

test('release: creates an annotated exact-source tag and generated-notes release, then retries without mutations', async t => {
  const repo = await createRepo(t);
  const fixture = await githubFixture(t);
  const environment = apiEnvironment(repo, fixture);
  successful(await invoke(repo, 'release', environment));
  assertStoredRelease(fixture, repo);
  assert.equal(fixture.tags.size, 1);
  assert.deepEqual(mutations(fixture).map(request => request.path), [
    `${fixture.prefix}/git/tags`, `${fixture.prefix}/git/refs`, `${fixture.prefix}/releases`,
  ]);
  const existingTag = fixture.refs.get(`tags/${releaseTag}`).object.sha;
  const existingRelease = structuredClone(fixture.releases.get(releaseTag));
  const count = fixture.requests.length;
  successful(await invoke(repo, 'release', environment));
  assertStoredRelease(fixture, repo);
  assert.equal(fixture.refs.get(`tags/${releaseTag}`).object.sha, existingTag);
  assert.equal(fixture.tags.size, 1);
  assert.deepEqual(fixture.releases.get(releaseTag), existingRelease);
  assert.deepEqual(fixture.requests.slice(count).filter(request => request.method !== 'GET'), []);
});

test('release: reuses an existing matching annotated tag without recreating it', async t => {
  const repo = await createRepo(t);
  const fixture = await githubFixture(t);
  const existingTag = fixture.storeTag(releaseTag, repo.commit);
  successful(await invoke(repo, 'release', apiEnvironment(repo, fixture)));
  assertStoredRelease(fixture, repo);
  assert.equal(fixture.refs.get(`tags/${releaseTag}`).object.sha, existingTag);
  assert.equal(fixture.tags.size, 1);
  assert.deepEqual(mutations(fixture).map(request => request.path), [`${fixture.prefix}/releases`]);
});

test('release: rejects existing annotated tag at a different commit without mutation', async t => {
  const repo = await createRepo(t);
  const fixture = await githubFixture(t);
  fixture.storeTag(releaseTag, otherCommit);
  failed(await invoke(repo, 'release', apiEnvironment(repo, fixture)));
  assert.equal(fixture.peel(`tags/${releaseTag}`), otherCommit);
  assert.equal(fixture.tags.size, 1);
  assert.equal(fixture.releases.size, 0);
  assert.deepEqual(mutations(fixture), []);
});

for (const [name, suffix] of [
  ['repository authorization', ''],
  ['tag ref lookup', `/git/ref/tags/${releaseTag}`],
]) {
  test(`release: failed ${name} cannot create tag or release`, async t => {
    const repo = await createRepo(t);
    const fixture = await githubFixture(t);
    fixture.failures.set(`GET ${fixture.prefix}${suffix}`, 503);
    failed(await invoke(repo, 'release', apiEnvironment(repo, fixture)));
    assert.equal(fixture.refs.size, 0);
    assert.equal(fixture.tags.size, 0);
    assert.equal(fixture.releases.size, 0);
    assert.deepEqual(mutations(fixture), []);
  });
}

test('release: failed annotated-tag lookup cannot create a release', async t => {
  const repo = await createRepo(t);
  const fixture = await githubFixture(t);
  const tagSha = fixture.storeTag(releaseTag, repo.commit);
  fixture.failures.set(`GET ${fixture.prefix}/git/tags/${tagSha}`, 503);
  failed(await invoke(repo, 'release', apiEnvironment(repo, fixture)));
  assert.equal(fixture.peel(`tags/${releaseTag}`), repo.commit);
  assert.equal(fixture.tags.size, 1);
  assert.equal(fixture.releases.size, 0);
  assert.deepEqual(mutations(fixture), []);
});

test('release: failed release lookup does not mutate an existing matching tag or create a release', async t => {
  const repo = await createRepo(t);
  const fixture = await githubFixture(t);
  fixture.storeTag(releaseTag, repo.commit);
  fixture.failures.set(`GET ${fixture.prefix}/releases/tags/${releaseTag}`, 503);
  failed(await invoke(repo, 'release', apiEnvironment(repo, fixture)));
  assert.equal(fixture.peel(`tags/${releaseTag}`), repo.commit);
  assert.equal(fixture.tags.size, 1);
  assert.equal(fixture.releases.size, 0);
  assert.deepEqual(mutations(fixture), []);
});

for (const suffix of ['/git/tags', '/git/refs']) {
  test(`release: ${suffix} creation failure prevents release creation`, async t => {
    const repo = await createRepo(t);
    const fixture = await githubFixture(t);
    fixture.failures.set(`POST ${fixture.prefix}${suffix}`, 503);
    failed(await invoke(repo, 'release', apiEnvironment(repo, fixture)));
    assert.equal(fixture.refs.size, 0);
    assert.equal(fixture.releases.size, 0);
    assert.equal(fixture.tags.size, suffix === '/git/tags' ? 0 : 1);
    assert.equal(mutations(fixture).some(request => request.path === `${fixture.prefix}/releases`), false);
  });
}

test('eligible: repository authorization failure is fatal rather than a deleted-ref skip', async t => {
  const repo = await createRepo(t);
  const fixture = await githubFixture(t, { mainCommit: repo.commit });
  fixture.failures.set(`GET ${fixture.prefix}`, 404);
  failed(await invoke(repo, 'eligible', apiEnvironment(repo, fixture)));
  assert.equal(fixture.requests.length, 1);
  assert.deepEqual(mutations(fixture), []);
});

for (const [name, options, tag] of [
  ['mismatched release tag', {}, 'v1.2.4'],
  ['prerelease root version', { version: '1.2.3-rc.1' }, 'v1.2.3-rc.1'],
  ['build-metadata root version', { version: '1.2.3+build.1' }, 'v1.2.3+build.1'],
]) {
  test(`release: ${name} fails before API mutation`, async t => {
    const repo = await createRepo(t, options);
    const fixture = await githubFixture(t);
    failed(await invoke(repo, 'release', apiEnvironment(repo, fixture, { RELEASE_TAG: tag })));
    assert.equal(fixture.refs.size, 0);
    assert.equal(fixture.tags.size, 0);
    assert.equal(fixture.releases.size, 0);
    assert.deepEqual(mutations(fixture), []);
  });
}
