/**
 * Minimal fake Kubernetes API server (node:http on 127.0.0.1) for unit tests of the
 * container domain's Kubernetes provider. Response shapes follow kube-apiserver v1.31
 * (core/v1 Pod/Event/Node, apps/v1 Deployment/StatefulSet, metrics.k8s.io/v1beta1,
 * authentication/authorization self reviews, metav1.Status errors). Only the endpoints
 * workctl uses are implemented.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type RequestListener, type Server } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const TOKEN = 'fake-sa-token-0123456789';
export const SA_USER = 'system:serviceaccount:demo:workctl';

type Obj = Record<string, any>;

export interface FakeK8sState {
  deployments: Obj[];
  statefulsets?: Obj[];
  pods: Obj[];
  events: Obj[];
  /** ReplicaSets; undefined → the replicasets endpoint answers 404. */
  replicasets?: Obj[];
  /** null → metrics.k8s.io is not registered (404 like a cluster without metrics-server). */
  podMetrics: Obj[] | null;
  /** true → the metrics.k8s.io APIService is registered but unavailable (503). */
  metricsUnavailable?: boolean;
  nodes: Obj[];
  /** `verb resource` pairs the service account may not use, e.g. `patch deployments`, `list nodes`. */
  forbidden?: Set<string>;
  /** Rollout behaviour after PATCH: complete after `afterMs`, never complete, or exceed the progress deadline. */
  rollout?: { mode: 'complete' | 'stuck' | 'deadline'; afterMs?: number };
  /** PATCH changes nothing (e.g. the same restartedAt value was already set): generation stays. */
  patchNoop?: boolean;
}

const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

export function status(code: number, reason: string, message: string, details: Obj = {}): Obj {
  return { kind: 'Status', apiVersion: 'v1', metadata: {}, status: 'Failure', message, reason, details, code };
}

function forbiddenMessage(verb: string, resource: string, group: string, ns?: string, name?: string): string {
  const res = group ? `${resource}.${group}` : resource;
  return `${res}${name ? ` "${name}"` : ''} is forbidden: User "${SA_USER}" cannot ${verb} resource "${resource}" in API group "${group}"${ns ? ` in the namespace "${ns}"` : ' at the cluster scope'}`;
}

/** Parse the label selector string forms workctl sends (equality and set based). */
export function matchSelector(selector: string | null, labels: Record<string, string> = {}): boolean {
  if (!selector) return true;
  const parts = selector.match(/([^,(]+\([^)]*\)|[^,]+)/g) ?? [];
  return parts.every((raw) => {
    const p = raw.trim();
    let m: RegExpExecArray | null;
    if ((m = /^(\S+)\s+(in|notin)\s+\(([^)]*)\)$/.exec(p))) {
      const vals = m[3].split(',').map((x) => x.trim());
      return m[2] === 'in' ? vals.includes(labels[m[1]]) : !vals.includes(labels[m[1]]);
    }
    if ((m = /^(\S+?)!=(.*)$/.exec(p))) return labels[m[1]] !== m[2];
    if ((m = /^(\S+?)==?(.*)$/.exec(p))) return labels[m[1]] === m[2];
    if (p.startsWith('!')) return !(p.slice(1) in labels);
    return p in labels;
  });
}

// ---------------------------------------------------------------------------
// fixture builders (shapes as returned by kube-apiserver v1.31)
// ---------------------------------------------------------------------------
export function deployment(o: { name: string; ns?: string; labels: Record<string, string>; replicas?: number; image?: string; limits?: Obj; requests?: Obj; generation?: number }): Obj {
  const ns = o.ns ?? 'demo';
  const gen = o.generation ?? 3;
  const replicas = o.replicas ?? 2;
  return {
    kind: 'Deployment',
    apiVersion: 'apps/v1',
    metadata: {
      name: o.name,
      namespace: ns,
      uid: `d0000000-0000-4000-8000-${Buffer.from(o.name).toString("hex").slice(-12).padStart(12, "0")}`,
      resourceVersion: '41234',
      generation: gen,
      creationTimestamp: '2026-10-17T10:00:00Z',
      labels: { app: o.labels.app ?? o.name },
      annotations: { 'deployment.kubernetes.io/revision': '3' },
    },
    spec: {
      replicas,
      selector: { matchLabels: o.labels },
      template: {
        metadata: { creationTimestamp: null, labels: { ...o.labels, 'workctl.env': 'sandbox' } },
        spec: {
          containers: [
            {
              name: 'nginx',
              image: o.image ?? 'nginx:1.27-alpine',
              ports: [{ name: 'http', containerPort: 80, protocol: 'TCP' }],
              resources: { limits: o.limits ?? { cpu: '500m', memory: '256Mi' }, requests: o.requests ?? { cpu: '100m', memory: '64Mi' } },
              readinessProbe: { httpGet: { path: '/', port: 80, scheme: 'HTTP' }, timeoutSeconds: 1, periodSeconds: 5, successThreshold: 1, failureThreshold: 3 },
              terminationMessagePath: '/dev/termination-log',
              terminationMessagePolicy: 'File',
              imagePullPolicy: 'IfNotPresent',
            },
          ],
          restartPolicy: 'Always',
          terminationGracePeriodSeconds: 30,
          dnsPolicy: 'ClusterFirst',
          schedulerName: 'default-scheduler',
        },
      },
      strategy: { type: 'RollingUpdate', rollingUpdate: { maxUnavailable: '25%', maxSurge: '25%' } },
      revisionHistoryLimit: 10,
      progressDeadlineSeconds: 600,
    },
    status: {
      observedGeneration: gen,
      replicas,
      updatedReplicas: replicas,
      readyReplicas: replicas,
      availableReplicas: replicas,
      conditions: [
        { type: 'Available', status: 'True', lastUpdateTime: '2026-10-17T10:01:00Z', lastTransitionTime: '2026-10-17T10:01:00Z', reason: 'MinimumReplicasAvailable', message: 'Deployment has minimum availability.' },
        { type: 'Progressing', status: 'True', lastUpdateTime: '2026-10-17T10:01:00Z', lastTransitionTime: '2026-10-17T10:00:00Z', reason: 'NewReplicaSetAvailable', message: `ReplicaSet "${o.name}-7c9d8f6b5" has successfully progressed.` },
      ],
    },
  };
}

export function pod(o: {
  name: string;
  ns?: string;
  labels: Record<string, string>;
  rs?: string;
  node?: string;
  ready?: boolean;
  restartCount?: number;
  lastTerminated?: Obj;
  waiting?: Obj;
  limits?: Obj;
  requests?: Obj;
  phase?: string;
}): Obj {
  const ns = o.ns ?? 'demo';
  const ready = o.ready ?? true;
  const uid = `p0000000-0000-4000-8000-${Buffer.from(o.name).toString('hex').slice(-12).padStart(12, '0')}`;
  return {
    kind: 'Pod',
    apiVersion: 'v1',
    metadata: {
      name: o.name,
      generateName: o.rs ? `${o.rs}-` : undefined,
      namespace: ns,
      uid,
      resourceVersion: '41300',
      creationTimestamp: '2026-10-17T10:00:05Z',
      labels: o.labels,
      ...(o.rs ? { ownerReferences: [{ apiVersion: 'apps/v1', kind: 'ReplicaSet', name: o.rs, uid: `r0000000-0000-4000-8000-${Buffer.from(o.rs).toString("hex").slice(-12).padStart(12, "0")}`, controller: true, blockOwnerDeletion: true }] } : {}),
    },
    spec: {
      volumes: [
        { name: 'kube-api-access-x7k2p', projected: { sources: [{ serviceAccountToken: { expirationSeconds: 3607, path: 'token' } }], defaultMode: 420 } },
        { name: 'html', configMap: { name: 'demo-order-html', defaultMode: 420 } },
      ],
      containers: [
        {
          name: 'nginx',
          image: 'nginx:1.27-alpine',
          ports: [{ name: 'http', containerPort: 80, protocol: 'TCP' }],
          resources: { limits: o.limits ?? { cpu: '500m', memory: '256Mi' }, requests: o.requests ?? { cpu: '100m', memory: '64Mi' } },
          volumeMounts: [
            { name: 'html', readOnly: true, mountPath: '/usr/share/nginx/html' },
            { name: 'kube-api-access-x7k2p', readOnly: true, mountPath: '/var/run/secrets/kubernetes.io/serviceaccount' },
          ],
          readinessProbe: { httpGet: { path: '/', port: 80, scheme: 'HTTP' }, timeoutSeconds: 1, periodSeconds: 5, successThreshold: 1, failureThreshold: 3 },
          imagePullPolicy: 'IfNotPresent',
        },
      ],
      restartPolicy: 'Always',
      nodeName: o.node ?? 'k3s-node-1',
      serviceAccountName: 'default',
    },
    status: {
      phase: o.phase ?? 'Running',
      conditions: [
        { type: 'PodReadyToStartContainers', status: 'True', lastProbeTime: null, lastTransitionTime: '2026-10-17T10:00:07Z' },
        { type: 'Initialized', status: 'True', lastProbeTime: null, lastTransitionTime: '2026-10-17T10:00:05Z' },
        { type: 'Ready', status: ready ? 'True' : 'False', lastProbeTime: null, lastTransitionTime: '2026-10-17T10:00:09Z', ...(ready ? {} : { reason: 'ContainersNotReady', message: 'containers with unready status: [nginx]' }) },
        { type: 'ContainersReady', status: ready ? 'True' : 'False', lastProbeTime: null, lastTransitionTime: '2026-10-17T10:00:09Z' },
        { type: 'PodScheduled', status: 'True', lastProbeTime: null, lastTransitionTime: '2026-10-17T10:00:05Z' },
      ],
      hostIP: '172.20.0.2',
      hostIPs: [{ ip: '172.20.0.2' }],
      podIP: '10.42.0.15',
      podIPs: [{ ip: '10.42.0.15' }],
      startTime: '2026-10-17T10:00:05Z',
      qosClass: 'Burstable',
      containerStatuses: [
        {
          name: 'nginx',
          state: o.waiting ? { waiting: o.waiting } : { running: { startedAt: '2026-10-17T11:20:00Z' } },
          lastState: o.lastTerminated ? { terminated: o.lastTerminated } : {},
          ready: o.waiting ? false : ready,
          restartCount: o.restartCount ?? 0,
          image: 'docker.io/library/nginx:1.27-alpine',
          imageID: 'docker.io/library/nginx@sha256:2140dad235c130ac861018a4e13a6bc8aea3a35f3a40e20c1b060d51a7efd250',
          containerID: `containerd://${Buffer.from(o.name).toString('hex').padEnd(64, '0').slice(0, 64)}`,
          started: !o.waiting,
          volumeMounts: [{ name: 'html', mountPath: '/usr/share/nginx/html', readOnly: true, recursiveReadOnly: 'Disabled' }],
        },
      ],
    },
  };
}

export function event(o: { involved: Obj; reason: string; message: string; type?: string; secondsAgo: number; count?: number; firstSecondsAgo?: number }): Obj {
  const io = o.involved;
  return {
    kind: 'Event',
    apiVersion: 'v1',
    metadata: { name: `${io.metadata.name}.${(1_800_000_000 + o.secondsAgo).toString(16)}`, namespace: io.metadata.namespace, uid: `e-${o.reason}-${o.secondsAgo}`, resourceVersion: '41400', creationTimestamp: ago(o.firstSecondsAgo ?? o.secondsAgo) },
    involvedObject: {
      kind: io.kind,
      namespace: io.metadata.namespace,
      name: io.metadata.name,
      uid: io.metadata.uid,
      apiVersion: io.apiVersion,
      resourceVersion: io.metadata.resourceVersion,
      ...(io.kind === 'Pod' ? { fieldPath: 'spec.containers{nginx}' } : {}),
    },
    reason: o.reason,
    message: o.message,
    source: { component: io.kind === 'Pod' ? 'kubelet' : 'deployment-controller', ...(io.kind === 'Pod' ? { host: 'k3s-node-1' } : {}) },
    firstTimestamp: ago(o.firstSecondsAgo ?? o.secondsAgo),
    lastTimestamp: ago(o.secondsAgo),
    count: o.count ?? 1,
    type: o.type ?? 'Normal',
    eventTime: null,
    reportingComponent: io.kind === 'Pod' ? 'kubelet' : 'deployment-controller',
    reportingInstance: io.kind === 'Pod' ? 'k3s-node-1' : '',
  };
}

export function podMetric(p: Obj, cpu: string, memory: string): Obj {
  return {
    kind: 'PodMetrics',
    apiVersion: 'metrics.k8s.io/v1beta1',
    metadata: { name: p.metadata.name, namespace: p.metadata.namespace, creationTimestamp: now(), labels: p.metadata.labels },
    timestamp: ago(5),
    window: '15.012s',
    containers: [{ name: 'nginx', usage: { cpu, memory } }],
  };
}

export function node(name: string): Obj {
  return {
    kind: 'Node',
    apiVersion: 'v1',
    metadata: { name, uid: `n-${name}`, labels: { 'kubernetes.io/hostname': name, 'node-role.kubernetes.io/control-plane': 'true' } },
    spec: { podCIDR: '10.42.0.0/24' },
    status: {
      capacity: { cpu: '4', memory: '8048288Ki', pods: '110', 'ephemeral-storage': '61202244Ki' },
      allocatable: { cpu: '4', memory: '8048288Ki', pods: '110', 'ephemeral-storage': '59536845766' },
      nodeInfo: { kubeletVersion: 'v1.31.4+k3s1', containerRuntimeVersion: 'containerd://1.7.23-k3s2', osImage: 'K3s v1.31.4+k3s1', architecture: 'amd64', operatingSystem: 'linux' },
    },
  };
}

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------
export async function startFakeK8s(
  state: FakeK8sState,
  tls?: { key: string | Buffer; cert: string | Buffer },
): Promise<{ url: string; dir: string; calls: string[]; bodies: Obj[]; close: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), 'workctl-fake-k8s-'));
  const calls: string[] = [];
  const bodies: Obj[] = [];
  const handler: RequestListener = (req, res) => {
    const u = new URL(req.url ?? '/', 'http://k8s');
    calls.push(`${req.method} ${u.pathname}${u.search}`);
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const send = (code: number, body: unknown) => {
        res.writeHead(code, { 'content-type': 'application/json', 'audit-id': 'fake' });
        res.end(JSON.stringify(body));
      };
      const bodyText = Buffer.concat(chunks).toString('utf8');
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, status(401, 'Unauthorized', 'Unauthorized'));
      const deny = (verb: string, resource: string, group: string, ns?: string, name?: string) => {
        if (!state.forbidden?.has(`${verb} ${resource}`)) return false;
        send(403, status(403, 'Forbidden', forbiddenMessage(verb, resource, group, ns, name), { ...(name ? { name } : {}), group, kind: resource }));
        return true;
      };
      const list = (kind: string, items: Obj[], apiVersion = 'v1') => send(200, { kind: `${kind}List`, apiVersion, metadata: { resourceVersion: '41500' }, items });
      const sel = u.searchParams.get('labelSelector');
      const p = u.pathname;
      let m: RegExpExecArray | null;
      if (p === '/version') {
        return send(200, { major: '1', minor: '31', gitVersion: 'v1.31.4+k3s1', gitCommit: 'a0e7bb4c', gitTreeState: 'clean', buildDate: '2024-12-12T23:12:00Z', goVersion: 'go1.22.9', compiler: 'gc', platform: 'linux/amd64' });
      }
      if (p === '/apis/authentication.k8s.io/v1/selfsubjectreviews' && req.method === 'POST') {
        return send(201, { kind: 'SelfSubjectReview', apiVersion: 'authentication.k8s.io/v1', metadata: { creationTimestamp: null }, status: { userInfo: { username: SA_USER, uid: 'sa-uid', groups: ['system:serviceaccounts', 'system:serviceaccounts:demo', 'system:authenticated'] } } });
      }
      if (p === '/apis/authorization.k8s.io/v1/selfsubjectrulesreviews' && req.method === 'POST') {
        const spec = JSON.parse(bodyText || '{}').spec ?? {};
        return send(201, {
          kind: 'SelfSubjectRulesReview',
          apiVersion: 'authorization.k8s.io/v1',
          metadata: { creationTimestamp: null },
          spec,
          status: {
            resourceRules: [
              { verbs: ['create'], apiGroups: ['authorization.k8s.io'], resources: ['selfsubjectaccessreviews', 'selfsubjectrulesreviews'] },
              { verbs: ['get', 'list', 'watch'], apiGroups: [''], resources: ['pods', 'events'] },
              { verbs: ['get', 'list', 'patch'], apiGroups: ['apps'], resources: ['deployments'] },
              { verbs: ['get', 'list'], apiGroups: ['metrics.k8s.io'], resources: ['pods'] },
            ],
            nonResourceRules: [{ verbs: ['get'], nonResourceURLs: ['/version', '/healthz'] }],
            incomplete: false,
          },
        });
      }
      if ((m = /^\/api\/v1\/namespaces\/([^/]+)\/pods$/.exec(p))) {
        if (deny('list', 'pods', '', m[1])) return;
        return list('Pod', state.pods.filter((x) => x.metadata.namespace === m![1] && matchSelector(sel, x.metadata.labels)));
      }
      if ((m = /^\/api\/v1\/namespaces\/([^/]+)\/events$/.exec(p))) {
        if (deny('list', 'events', '', m[1])) return;
        return list('Event', state.events.filter((x) => x.metadata.namespace === m![1]));
      }
      if (p === '/api/v1/nodes') {
        if (deny('list', 'nodes', '')) return;
        return list('Node', state.nodes);
      }
      if ((m = /^\/api\/v1\/nodes\/([^/]+)$/.exec(p))) {
        if (deny('get', 'nodes', '', undefined, m[1])) return;
        const n = state.nodes.find((x) => x.metadata.name === m![1]);
        return n ? send(200, n) : send(404, status(404, 'NotFound', `nodes "${m[1]}" not found`, { name: m[1], kind: 'nodes' }));
      }
      if ((m = /^\/apis\/apps\/v1\/namespaces\/([^/]+)\/(deployments|statefulsets)(?:\/([^/]+))?$/.exec(p))) {
        const [, ns, plural, name] = m;
        const coll = plural === 'deployments' ? state.deployments : (state.statefulsets ??= []);
        if (!name) {
          if (deny('list', plural, 'apps', ns)) return;
          return list(plural === 'deployments' ? 'Deployment' : 'StatefulSet', coll.filter((x) => x.metadata.namespace === ns && matchSelector(sel, x.metadata.labels)), 'apps/v1');
        }
        const obj = coll.find((x) => x.metadata.namespace === ns && x.metadata.name === decodeURIComponent(name));
        if (req.method === 'PATCH') {
          if (deny('patch', plural, 'apps', ns, name)) return;
          if (!obj) return send(404, status(404, 'NotFound', `${plural}.apps "${name}" not found`, { name, group: 'apps', kind: plural }));
          if (req.headers['content-type'] !== 'application/strategic-merge-patch+json') return send(415, status(415, 'UnsupportedMediaType', 'unsupported patch type'));
          const patch = JSON.parse(bodyText);
          bodies.push(patch);
          if (state.patchNoop) return send(200, obj);
          const ann = patch?.spec?.template?.metadata?.annotations ?? {};
          obj.spec.template.metadata.annotations = { ...(obj.spec.template.metadata.annotations ?? {}), ...ann };
          obj.metadata.generation += 1;
          const gen = obj.metadata.generation;
          const replicas = obj.spec.replicas;
          // rollout begins: controller has not observed it yet, one new replica created
          Object.assign(obj.status, { updatedReplicas: 0, replicas: replicas + 1, unavailableReplicas: 1 });
          const mode = state.rollout?.mode ?? 'complete';
          setTimeout(() => {
            obj.status.observedGeneration = gen;
            if (mode === 'complete') {
              Object.assign(obj.status, { replicas, updatedReplicas: replicas, readyReplicas: replicas, availableReplicas: replicas });
              delete obj.status.unavailableReplicas;
            } else if (mode === 'stuck') {
              Object.assign(obj.status, { updatedReplicas: 1, availableReplicas: replicas - 1 });
            } else {
              Object.assign(obj.status, { updatedReplicas: 1 });
              obj.status.conditions = obj.status.conditions.map((c: Obj) =>
                c.type === 'Progressing' ? { ...c, status: 'False', reason: 'ProgressDeadlineExceeded', message: `ReplicaSet "${obj.metadata.name}-5f6d7c8b9" has timed out progressing.` } : c,
              );
            }
          }, state.rollout?.afterMs ?? 150);
          return send(200, obj);
        }
        if (deny('get', plural, 'apps', ns, name)) return;
        return obj ? send(200, obj) : send(404, status(404, 'NotFound', `${plural}.apps "${name}" not found`, { name, group: 'apps', kind: plural }));
      }
      if ((m = /^\/apis\/apps\/v1\/namespaces\/([^/]+)\/replicasets$/.exec(p)) && state.replicasets) {
        if (deny('list', 'replicasets', 'apps', m[1])) return;
        return list('ReplicaSet', state.replicasets.filter((x) => x.metadata.namespace === m![1] && matchSelector(sel, x.metadata.labels)), 'apps/v1');
      }
      if ((m = /^\/apis\/metrics\.k8s\.io\/v1beta1\/namespaces\/([^/]+)\/pods$/.exec(p))) {
        if (state.metricsUnavailable) return send(503, status(503, 'ServiceUnavailable', 'the server is currently unable to handle the request'));
        if (!state.podMetrics) return send(404, status(404, 'NotFound', 'the server could not find the requested resource'));
        if (deny('list', 'pods', 'metrics.k8s.io', m[1])) return;
        return send(200, { kind: 'PodMetricsList', apiVersion: 'metrics.k8s.io/v1beta1', metadata: {}, items: state.podMetrics.filter((x) => x.metadata.namespace === m![1] && matchSelector(sel, x.metadata.labels)) });
      }
      send(404, status(404, 'NotFound', 'the server could not find the requested resource'));
    });
  };
  const server: Server = tls ? createTlsServer({ key: tls.key, cert: tls.cert }, handler) : createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as { port: number };
  return { url: `${tls ? 'https' : 'http'}://127.0.0.1:${addr.port}`, dir, calls, bodies, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** Writes a profile with a kubernetes endpoint (token via file: ref) and k8s bindings; returns the config path. */
export function writeK8sConfig(
  dir: string,
  o: { server: string; bindings?: string; withDocker?: string; allowExecute?: boolean; endpoint?: Record<string, unknown>; token?: string },
): string {
  writeFileSync(join(dir, 'k8s-token'), `${o.token ?? TOKEN}\n`);
  writeFileSync(
    join(dir, 'bindings.yaml'),
    o.bindings ??
      `schema_version: "1.0"
resources:
  - { id: demo-order, type: service, env: sandbox }
  - id: demo-order-k8s
    type: container.workload
    env: sandbox
    endpoint: { kind: kubernetes, name: k3s }
    labels: { app: demo-order }
    attributes: { namespace: demo }
  - { id: demo-pay, type: service, env: sandbox }
  - id: demo-pay-k8s
    type: container.workload
    env: sandbox
    endpoint: { kind: kubernetes, name: k3s }
    attributes: { namespace: demo, deployment: demo-pay }
  - { id: demo-ghost, type: service, env: sandbox }
  - id: demo-ghost-k8s
    type: container.workload
    env: sandbox
    endpoint: { kind: kubernetes, name: k3s }
    attributes: { namespace: demo, deployment: demo-ghost }
  - { id: demo-mysql, type: mysql.instance, env: sandbox }
relations:
  - { from: demo-order, to: demo-order-k8s, type: runs_on, source: binding-file, evidence: "Deployment demo/demo-order pods labelled app=demo-order" }
  - { from: demo-order, to: demo-mysql, type: depends_on, source: service-config }
  - { from: demo-pay, to: demo-pay-k8s, type: runs_on, source: binding-file }
  - { from: demo-ghost, to: demo-ghost-k8s, type: runs_on, source: binding-file }
`,
  );
  const cfg = {
    schema_version: '1.0',
    current_profile: 't',
    profiles: {
      t: {
        env: 'sandbox',
        allow_execute: o.allowExecute ?? true,
        resources_file: './bindings.yaml',
        state_dir: './state',
        endpoints: {
          kubernetes: { k3s: o.endpoint ?? { server: o.server, token_ref: 'file:k8s-token', namespace: 'demo' } },
          ...(o.withDocker ? { docker: { local: { socket: o.withDocker } } } : {}),
        },
      },
    },
  };
  const path = join(dir, 'workctl.yaml');
  writeFileSync(path, JSON.stringify(cfg));
  return path;
}
