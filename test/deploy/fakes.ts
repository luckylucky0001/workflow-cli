/**
 * Fake deploy-system backends for unit tests of the deploy domain:
 *  - Jenkins REST API (jobs/builds/consoleText/queue/me/config.xml, X-Jenkins header, basic auth)
 *  - Kubernetes apps/v1 Deployment + ReplicaSets + pods with JSON-patch rollback
 * Shapes follow Jenkins 2.541 and kube-apiserver v1.31.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { deployment, matchSelector, status } from '../container/fake-k8s';

type Obj = Record<string, any>;

export const JENKINS_PASSWORD = 'jenkins-test-pw';

export interface FakeJenkinsState {
  builds: Obj[];
  queue: Obj[];
  console: Record<number, string>;
  /** respond to every request with this status */
  failWith?: number;
  /** POSTs received (path + query + crumb header) */
  posts?: { path: string; query: string; crumb: string | undefined; cookie: string | undefined }[];
  numToKeep?: number;
}

export function jbuild(n: number, o: { version: string; service?: string; env?: string; result?: string | null; building?: boolean; minutesAgo?: number; user?: string; secretParam?: boolean }): Obj {
  const ts = Date.now() - (o.minutesAgo ?? 60 - n) * 60_000;
  return {
    _class: 'hudson.model.FreeStyleBuild',
    number: n,
    url: `http://jenkins.local/job/deploy-demo-order/${n}/`,
    result: o.building ? null : o.result ?? 'SUCCESS',
    building: !!o.building,
    timestamp: ts,
    duration: o.building ? 0 : 2017,
    estimatedDuration: 2030,
    actions: [
      { _class: 'hudson.model.ParametersAction', parameters: [
        { _class: 'hudson.model.StringParameterValue', name: 'SERVICE', value: o.service ?? 'demo-order' },
        { _class: 'hudson.model.StringParameterValue', name: 'VERSION', value: o.version },
        { _class: 'hudson.model.StringParameterValue', name: 'ENV', value: o.env ?? 'sandbox' },
        ...(o.secretParam ? [{ _class: 'hudson.model.PasswordParameterValue', name: 'DEPLOY_TOKEN' }] : []),
      ] },
      { _class: 'hudson.model.CauseAction', causes: [{ _class: 'hudson.model.Cause$UserIdCause', shortDescription: `Started by user ${o.user ?? 'alice'}`, userId: o.user ?? 'alice', userName: o.user ?? 'alice' }] },
      {},
      null,
    ],
  };
}

export async function startFakeJenkins(state: FakeJenkinsState): Promise<{ url: string; server: Server; requests: string[] }> {
  const requests: string[] = [];
  const expected = `Basic ${Buffer.from(`admin:${JENKINS_PASSWORD}`).toString('base64')}`;
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    requests.push(`${req.method} ${u.pathname}`);
    res.setHeader('X-Jenkins', '2.541.3');
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json;charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    if (state.failWith) return json(state.failWith, { message: 'nope' });
    if (req.headers.authorization !== expected) {
      res.writeHead(401, { 'content-type': 'text/html' });
      return res.end('<html>Authentication required</html>');
    }
    const p = u.pathname;
    if (p === '/me/api/json') return json(200, { id: 'admin', fullName: 'admin' });
    if (p === '/api/json') return json(200, { numExecutors: 2, jobs: [{ name: 'deploy-demo-order' }] });
    if (p === '/queue/api/json') return json(200, { items: state.queue });
    if (p === '/job/deploy-demo-order/api/json') {
      const tree = u.searchParams.get('tree') ?? '';
      const m = /\{0,(\d+)\}/.exec(tree);
      const builds = [...state.builds].sort((a, b) => b.number - a.number).slice(0, m ? Number(m[1]) : 100);
      return json(200, { _class: 'hudson.model.FreeStyleProject', builds });
    }
    if (p === '/job/deploy-demo-order/config.xml') {
      res.writeHead(200, { 'content-type': 'application/xml' });
      return res.end(`<project><properties><jenkins.model.BuildDiscarderProperty><strategy class="hudson.tasks.LogRotator"><daysToKeep>-1</daysToKeep><numToKeep>${state.numToKeep ?? 20}</numToKeep></strategy></jenkins.model.BuildDiscarderProperty></properties></project>`);
    }
    if (p === '/crumbIssuer/api/json') {
      res.setHeader('set-cookie', 'JSESSIONID.abc=node0xyz; Path=/; HttpOnly');
      return json(200, { _class: 'hudson.security.csrf.DefaultCrumbIssuer', crumb: 'crumb-123', crumbRequestField: 'Jenkins-Crumb' });
    }
    if (p === '/job/deploy-demo-order/buildWithParameters' && req.method === 'POST') {
      (state.posts ??= []).push({ path: p, query: u.search, crumb: req.headers['jenkins-crumb'] as string | undefined, cookie: req.headers.cookie });
      if (req.headers['jenkins-crumb'] !== 'crumb-123') return json(403, { message: 'No valid crumb was included in the request' });
      const n = Math.max(...state.builds.map((b) => b.number)) + 1;
      const version = u.searchParams.get('VERSION') ?? '';
      const b = jbuild(n, { version, service: u.searchParams.get('SERVICE') ?? undefined, env: u.searchParams.get('ENV') ?? undefined, result: version.includes('bad') ? 'FAILURE' : 'SUCCESS', minutesAgo: 0, user: 'admin' });
      state.builds.push(b);
      state.queue.push({ id: 900 + n, why: null, executable: { number: n }, task: { name: 'other-job' } });
      res.writeHead(201, { location: `http://jenkins.local/queue/item/${900 + n}/` });
      return res.end();
    }
    let m: RegExpExecArray | null;
    if ((m = /^\/queue\/item\/(\d+)\/api\/json$/.exec(p))) {
      const it = state.queue.find((x) => x.id === Number(m![1]));
      return it ? json(200, it) : json(404, {});
    }
    if ((m = /^\/job\/deploy-demo-order\/(\d+)\/api\/json$/.exec(p))) {
      const b = state.builds.find((x) => x.number === Number(m![1]));
      return b ? json(200, { ...b, builtOn: '' }) : (res.writeHead(404, { 'content-type': 'text/html' }), res.end('<html>Not Found</html>'));
    }
    if ((m = /^\/job\/deploy-demo-order\/(\d+)\/consoleText$/.exec(p))) {
      const c = state.console[Number(m[1])];
      if (c === undefined) return (res.writeHead(404), res.end());
      res.writeHead(200, { 'content-type': 'text/plain;charset=utf-8' });
      return res.end(c);
    }
    res.writeHead(404, { 'content-type': 'text/html' });
    res.end('<html>Not Found</html>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, server, requests };
}

// ---------------------------------------------------------------------------
// Kubernetes
// ---------------------------------------------------------------------------
export const K8S_TOKEN = 'fake-deploy-token';

export function replicaset(dep: Obj, o: { hash: string; revision: number; image: string; cause?: string; restartedAt?: string; replicas?: number; ready?: number; minutesAgo: number; owner?: string; history?: string; envVersion?: string }): Obj {
  const labels = { ...dep.spec.template.metadata.labels, 'pod-template-hash': o.hash };
  const template = JSON.parse(JSON.stringify(dep.spec.template));
  template.metadata.labels = labels;
  template.spec.containers[0].image = o.image;
  template.spec.containers[0].env = [{ name: 'RELEASE_VERSION', value: o.envVersion ?? `r${o.revision}` }, { name: 'DB_PASSWORD', value: 'hunter2' }];
  if (o.restartedAt) template.metadata.annotations = { 'kubectl.kubernetes.io/restartedAt': o.restartedAt };
  return {
    kind: 'ReplicaSet',
    metadata: {
      name: `${dep.metadata.name}-${o.hash}`,
      namespace: dep.metadata.namespace,
      uid: `rs-uid-${o.hash}`,
      creationTimestamp: new Date(Date.now() - o.minutesAgo * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      labels,
      annotations: {
        'deployment.kubernetes.io/revision': String(o.revision),
        ...(o.cause ? { 'kubernetes.io/change-cause': o.cause } : {}),
        ...(o.history ? { 'deployment.kubernetes.io/revision-history': o.history } : {}),
      },
      ownerReferences: [{ apiVersion: 'apps/v1', kind: 'Deployment', name: dep.metadata.name, uid: o.owner ?? dep.metadata.uid, controller: true }],
    },
    spec: { replicas: o.replicas ?? 0, selector: dep.spec.selector, template },
    status: { replicas: o.replicas ?? 0, readyReplicas: o.ready ?? o.replicas ?? 0, availableReplicas: o.ready ?? o.replicas ?? 0, observedGeneration: 1 },
  };
}

export interface FakeK8sDeployState {
  deployment: Obj;
  replicasets: Obj[];
  pods: Obj[];
  patches: { contentType: string; body: any }[];
  /** after a rollback PATCH the rollout completes immediately unless false */
  completeAfterPatch?: boolean;
  /** runs just before a PATCH is applied (simulates a concurrent change after the executor's recheck) */
  beforePatch?: (dep: Obj) => void;
}

/** Deployment demo/demo-order at revision 3 (hash ccc), older revisions 2 (bbb) and 1 (aaa). */
export function k8sDeployFixture(): FakeK8sDeployState {
  const dep = deployment({ name: 'demo-order', labels: { app: 'demo-order' }, replicas: 2, image: 'registry/demo-order:1.4.2' });
  dep.metadata.annotations = { 'deployment.kubernetes.io/revision': '3', 'kubernetes.io/change-cause': 'release 1.4.2' };
  dep.spec.revisionHistoryLimit = 10;
  dep.status.conditions = [
    { type: 'Available', status: 'True', reason: 'MinimumReplicasAvailable', lastUpdateTime: '2026-10-17T10:00:00Z' },
    { type: 'Progressing', status: 'True', reason: 'NewReplicaSetAvailable', message: 'ReplicaSet "demo-order-ccc" has successfully progressed.', lastUpdateTime: new Date(Date.now() - 9 * 60_000).toISOString() },
  ];
  const rs = [
    replicaset(dep, { hash: 'ccc', revision: 3, image: 'registry/demo-order:1.4.2', cause: 'release 1.4.2', replicas: 2, minutesAgo: 10, envVersion: '1.4.2' }),
    replicaset(dep, { hash: 'bbb', revision: 2, image: 'registry/demo-order:1.4.1', cause: 'release 1.4.1', minutesAgo: 60, envVersion: '1.4.1' }),
    replicaset(dep, { hash: 'aaa', revision: 1, image: 'registry/demo-order:1.4.0', cause: 'release 1.4.0', minutesAgo: 60 * 24 * 30, envVersion: '1.4.0' }),
    // same labels, other controller: must be excluded
    replicaset(dep, { hash: 'zzz', revision: 7, image: 'registry/other:1', minutesAgo: 5, owner: 'other-uid' }),
  ];
  const pods = [0, 1].map((i) => ({
    metadata: { name: `demo-order-ccc-${i}`, namespace: 'demo', labels: { app: 'demo-order', 'pod-template-hash': 'ccc' } },
    spec: { containers: [{ name: 'nginx', image: 'registry/demo-order:1.4.2' }] },
    status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }], containerStatuses: [{ name: 'nginx', ready: true, restartCount: 0, image: 'x', state: { running: {} } }] },
  }));
  return { deployment: dep, replicasets: rs, pods, patches: [] };
}

function applyJsonPatch(target: Obj, ops: { op: string; path: string; value?: unknown }[]): void {
  for (const o of ops) {
    const parts = o.path.split('/').slice(1).map((x) => x.replace(/~1/g, '/').replace(/~0/g, '~'));
    const last = parts.pop()!;
    const parent = parts.reduce((a, k) => a[k], target);
    if (o.op === 'test') {
      if (JSON.stringify(parent[last]) !== JSON.stringify(o.value)) throw Object.assign(new Error('test failed'), { code: 422 });
    } else parent[last] = JSON.parse(JSON.stringify(o.value));
  }
}

export async function startFakeK8sDeploy(state: FakeK8sDeployState): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${K8S_TOKEN}`) return json(401, status(401, 'Unauthorized', 'Unauthorized'));
    const p = u.pathname;
    const dep = state.deployment;
    if (p === '/version') return json(200, { major: '1', minor: '31', gitVersion: 'v1.31.4+k3s1' });
    if (p === '/apis/apps/v1/namespaces/demo/deployments/demo-order') {
      if (req.method === 'GET') return json(200, dep);
      if (req.method === 'PATCH') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          const ops = JSON.parse(body);
          state.patches.push({ contentType: String(req.headers['content-type']), body: ops });
          state.beforePatch?.(dep);
          try {
            applyJsonPatch(dep, ops);
          } catch {
            return json(422, status(422, 'Invalid', 'the server rejected our request due to an error in our request'));
          }
          dep.metadata.generation += 1;
          // controller: reuse the matching ReplicaSet (same template) with the next revision
          const next = Math.max(...state.replicasets.filter((r) => r.metadata.ownerReferences[0].uid === dep.metadata.uid).map((r) => Number(r.metadata.annotations['deployment.kubernetes.io/revision']))) + 1;
          const hit = state.replicasets.find((r) => r.spec.template.spec.containers[0].image === dep.spec.template.spec.containers[0].image && r.metadata.ownerReferences[0].uid === dep.metadata.uid);
          if (hit) {
            hit.metadata.annotations['deployment.kubernetes.io/revision-history'] = hit.metadata.annotations['deployment.kubernetes.io/revision'];
            hit.metadata.annotations['deployment.kubernetes.io/revision'] = String(next);
          }
          dep.metadata.annotations['deployment.kubernetes.io/revision'] = String(next);
          if (state.completeAfterPatch !== false) dep.status.observedGeneration = dep.metadata.generation;
          json(200, dep);
        });
        return;
      }
    }
    if (p === '/apis/apps/v1/namespaces/demo/replicasets') {
      return json(200, { kind: 'ReplicaSetList', items: state.replicasets.filter((r) => matchSelector(u.searchParams.get('labelSelector'), r.metadata.labels)) });
    }
    let m: RegExpExecArray | null;
    if ((m = /^\/apis\/apps\/v1\/namespaces\/demo\/replicasets\/([^/]+)$/.exec(p))) {
      const r = state.replicasets.find((x) => x.metadata.name === m![1]);
      return r ? json(200, r) : json(404, status(404, 'NotFound', `replicasets.apps "${m[1]}" not found`));
    }
    if (p === '/api/v1/namespaces/demo/pods') return json(200, { kind: 'PodList', items: state.pods.filter((x) => matchSelector(u.searchParams.get('labelSelector'), x.metadata.labels)) });
    json(404, status(404, 'NotFound', 'the server could not find the requested resource'));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, server };
}

/** Profile with both providers: demo-order → jenkins (sandbox), demo-order → kubernetes (staging), demo-mysql without deploy binding. */
export function writeDeployConfig(o: { jenkinsUrl?: string; k8sUrl?: string; password?: string; allowExecute?: boolean }): string {
  const dir = mkdtempSync(join(tmpdir(), 'workctl-deploy-'));
  writeFileSync(join(dir, 'jenkins.pw'), `${o.password ?? JENKINS_PASSWORD}\n`);
  writeFileSync(join(dir, 'k8s.token'), `${K8S_TOKEN}\n`);
  const bindings = {
    resources: [
      { id: 'demo-order', type: 'service' },
      { id: 'demo-mysql', type: 'mysql.instance' },
      { id: 'demo-order-jenkins', type: 'deploy.target', env: 'sandbox', endpoint: { kind: 'jenkins', name: 'ci' }, attributes: { service: 'demo-order', job: 'deploy-demo-order', version_param: 'VERSION', service_param: 'SERVICE', env_param: 'ENV' } },
      { id: 'demo-order-k8s', type: 'deploy.target', env: 'staging', endpoint: { kind: 'kubernetes', name: 'k' }, attributes: { service: 'demo-order', namespace: 'demo', deployment: 'demo-order' } },
    ],
    relations: [{ from: 'demo-order', to: 'demo-mysql', type: 'depends_on', source: 'service-config' }],
  };
  writeFileSync(join(dir, 'bindings.yaml'), YAML.stringify(bindings));
  const endpoints: Obj = {};
  if (o.jenkinsUrl) endpoints.jenkins = { ci: { url: o.jenkinsUrl, user: 'admin', password_ref: 'file:jenkins.pw' } };
  if (o.k8sUrl) endpoints.kubernetes = { k: { server: o.k8sUrl, token_ref: 'file:k8s.token', namespace: 'demo' } };
  const cfg = {
    current_profile: 'sandbox',
    profiles: {
      sandbox: { env: 'sandbox', allow_execute: o.allowExecute ?? true, resources_file: './bindings.yaml', state_dir: './state', endpoints },
      staging: { env: 'staging', allow_execute: o.allowExecute ?? true, resources_file: './bindings.yaml', state_dir: './state-staging', endpoints },
    },
  };
  const p = join(dir, 'workctl.yaml');
  writeFileSync(p, YAML.stringify(cfg));
  return p;
}
