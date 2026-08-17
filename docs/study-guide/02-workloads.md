# Workloads and Scheduling — CKA Study Guide

This domain accounts for **15%** of the CKA exam. It focuses on keeping *applications* healthy (as opposed to the cluster itself): deploying apps, updating them with zero downtime, self-healing, configuration, autoscaling, and controlling *where* pods run.

Exam workflow reminders that appear throughout: each task gives you a `kubectl config use-context <ctx>` command — **always run it first** so you operate in the correct cluster/namespace. Set an alias `alias k=kubectl` and an env var `export do='--dry-run=client -o yaml'` to generate boilerplate YAML quickly and avoid typos.

---

## 1. Controllers and Workload Primitives

In Kubernetes you rarely create a standalone (bare/naked) pod, because nothing looks after it — if it dies, it stays dead, and it will not be recreated if its node fails. Instead you use **controllers**. A controller is a control loop that watches the current state of the cluster through the API server and makes changes to drive it toward the **desired state** you declared. Controllers run inside the **kube-controller-manager** (one per cluster) on the control plane; cloud-specific control loops run in the **cloud-controller-manager**.

### Choosing the right controller

| Controller | Use case | Lifetime | Scaling |
|---|---|---|---|
| **Deployment** | Stateless apps (web servers, APIs); CKA default | Long-running | Manual or HPA |
| **StatefulSet** | Stateful apps (databases); stable identity + storage | Long-running | Manual or HPA |
| **DaemonSet** | One pod per node (log collectors, kube-proxy, monitoring) | Long-running | Automatic — one per node |
| **Job** | Run a batch task to successful completion, then stop | Temporary | Based on completions |
| **CronJob** | Create Jobs on a recurring schedule | Temporary, recurring | Based on completions |

- A **Deployment** manages stateless workloads where every pod is interchangeable. It does *not* create pods directly — it creates a **ReplicaSet**, which creates the pods.
- A **StatefulSet** gives each pod a stable, unique identity (e.g. `db-0`, `db-1`). If `db-0` restarts it comes back as `db-0` with its same persistent storage; it also provides ordered scaling/rolling updates and stable network names.
- A **DaemonSet** ensures one copy of a pod runs on every node (or a subset). Add a node and the DaemonSet controller automatically spins up a pod on it.
- A **Job** creates one or more pods and ensures a defined number terminate **successfully**. A **CronJob** creates Jobs on a schedule (e.g. `0 0 * * 0` = every Sunday midnight).

> **💡 Exam Tip:** Know the architectural mapping cold — "one pod on every node" = DaemonSet, "stable identity for a database" = StatefulSet, "run once to completion" = Job, "run on a schedule" = CronJob, "stateless web app" = Deployment. This is a very common way the exam tests workload knowledge.

*Source: Workloads and Scheduling for CKA — Choosing the Right Workload Controller*

### ReplicaSet

A ReplicaSet deploys and maintains a defined number of identical pods. Three required elements: **replicas**, a **selector** (pod membership), and a **pod template**. If a pod dies, is deleted, or has its label changed so it no longer matches the selector, the ReplicaSet controller creates a replacement to maintain the desired count. Selectors support `matchLabels` (equality) and `matchExpressions` (set-based: operators `In`, `NotIn`, `Exists`, `DoesNotExist`). The older **ReplicationController** is the predecessor to ReplicaSet but supports only a single key/value selector.

You normally do **not** create ReplicaSets directly — create a Deployment, which manages ReplicaSets for you.

```yaml
apiVersion: apps/v1
kind: ReplicaSet
metadata:
  name: hello-world
spec:
  replicas: 3
  selector:
    matchLabels:
      app: hello-world
  template:
    metadata:
      labels:
        app: hello-world
    spec:
      containers:
      - name: hello-world
        image: nginx
```

**Node failures:** On a *transient* failure (node reboots, brief network loss), pods are marked with an error status; when the node returns, the kubelet restarts the containers (the pods stay scheduled there). On a *permanent* failure, the `pod-eviction-timeout` on the kube-controller-manager (default **5 minutes**) elapses, the pods are marked for termination, and the ReplicaSet creates replacements elsewhere.

> **💡 Exam Tip:** If you modify a pod's label so it leaves the ReplicaSet's selector, you get an **orphan pod** that the controller no longer manages — and deleting the controller will not delete it. Do not change labels/selectors after creation unless required.

*Source: Managing Kubernetes Controllers and Deployments — Understanding ReplicaSet Controller Operations*

### Jobs, CronJobs, DaemonSets — quick commands

```bash
k create job calculation --image=busybox -- sleep 5
k create cronjob backup --image=busybox --schedule="* * * * *" -- echo hi
k create deployment ds --image=nginx $do > ds.yaml   # then change kind to DaemonSet,
                                                       # remove replicas + strategy fields
```

For a **Job**, `completions` = number of required successful runs; `parallelism` = max pods running at once. With `completions: 6, parallelism: 2`, six pods run successfully in batches of two.

> **💡 Exam Tip:** A fast way to make a DaemonSet is to generate a Deployment YAML with `--dry-run=client -o yaml`, then change `kind` to `DaemonSet` and delete the `replicas` and `strategy` fields — a DaemonSet has neither.

*Source: Workloads and Scheduling for CKA — Demo: Managing Batch Workloads*

---

## 2. Deployments: Creating and Updating

### Creating a deployment

```bash
k create deployment hello-world --image=gcr.io/.../hello-app:1.0   # imperative, 1 replica
k scale deployment hello-world --replicas=5
k apply -f deployment.yaml                                          # declarative (preferred)
```

A Deployment spec requires **replicas**, a **selector**, and a **pod template**. Creating a Deployment creates a ReplicaSet (named with a **pod-template-hash**), which creates the pods. Use a fronting Service to give users access.

### Triggering an update

An update (rollout) is triggered **only by changing the pod template** (container image, env vars, labels, restart policy, etc.). Changing other deployment-spec fields like `replicas` does **not** trigger a rollout. Kubernetes creates a *new* ReplicaSet for the new pod template and transitions between the two, keeping the old one for rollback.

```bash
k set image deployment/hello-world hello-world=hello-app:2.0   # imperative update
k edit deployment hello-world                                  # edit in place
k apply -f deployment.yaml                                     # declarative (preferred)
```

### Checking rollout status

```bash
k rollout status deployment hello-world     # interactive view; exit code 0 = success, 1 = failed
k describe deployment hello-world
```

Deployment statuses: **Complete** (all new pods ready, old pods gone), **Progressing** (new ReplicaSet scaling up / old scaling down), **Failed** (couldn't reach desired replicas — resource limits, quotas, or failing readiness probes). `describe` shows replica counts: *desired*, *updated* (on new ReplicaSet), *total* (both ReplicaSets — can exceed desired during rollout), *available*, *unavailable*.

> **💡 Exam Tip:** Only pod-template changes start a rollout. `kubectl get deployment` shows READY / UP-TO-DATE / AVAILABLE; `kubectl rollout status` returns exit code 0 on success and 1 on failure — useful in scripts.

*Source: Managing Kubernetes Controllers and Deployments — Updating a Deployment and Checking Deployment Rollout Status*

### Update strategies

- **RollingUpdate** (default): start up the new ReplicaSet and scale it up while scaling the old one down — near-zero downtime. Controlled by:
  - **maxUnavailable** (default 25%): max pods that can be unavailable during the update (percentage or integer).
  - **maxSurge** (default 25%): max extra pods allowed *above* desired count during the update (percentage or integer).
- **Recreate**: terminate **all** old pods first, then start the new ones — guaranteed downtime, but never two versions at once. Use when versions can't run concurrently.

```yaml
spec:
  replicas: 20
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 20%
      maxSurge: 5
  revisionHistoryLimit: 20
  template:
    spec:
      containers:
      - name: app
        image: hello-app:1.0
        readinessProbe:
          httpGet:
            path: /index.html
            port: 8080
          initialDelaySeconds: 10
          periodSeconds: 10
```

**Always pair a RollingUpdate with a readiness probe.** A deployment stops a rollout if the number of pods failing readiness would push availability below `maxUnavailable`, protecting the running version. Without a readiness probe a pod is considered ready as soon as it starts, so a broken rollout continues unchecked.

> **💡 Exam Tip:** Increase both `maxSurge` and `maxUnavailable` (e.g. to 50%) for a *faster* rollout; lower them for a *safer*, slower rollout. `Recreate` only when the app can't tolerate two versions running simultaneously.

*Source: Managing Kubernetes Controllers and Deployments — Controlling Updates with UpdateStrategy*

### Pause, resume, and restart

```bash
k rollout pause deployment my-deployment    # batch edits without rolling them out
k rollout resume deployment my-deployment   # apply batched changes in one new rollout
k rollout restart deployment hello-world    # roll all pods (new ReplicaSet, same template)
```

> **💡 Exam Tip:** `rollout restart` is the clean way to cycle every pod (e.g. to pick up a changed Secret/ConfigMap mounted as env). It creates a *new* ReplicaSet with the same pod template — pods are never restarted in place.

*Source: Managing Kubernetes Controllers and Deployments — Pausing and Rolling Back Deployments*

---

## 3. Rollbacks and Revision History

Every pod-template change creates a new **revision** (really a new ReplicaSet kept around). By default Kubernetes stores **10** revisions; the eleventh update deletes the oldest. Control this with `revisionHistoryLimit` in the deployment spec (0 = clean up immediately). Add `--record` (now deprecated but still seen) to capture a `CHANGE-CAUSE` annotation describing each change.

```bash
k rollout history deployment hello-world                 # list revisions
k rollout history deployment hello-world --revision=2    # inspect a specific revision's pod template
k rollout undo deployment hello-world                    # roll back to previous revision
k rollout undo deployment hello-world --to-revision=2    # roll back to a specific revision
```

When you `undo`, Kubernetes scales down the current ReplicaSet and scales the chosen old one back up. Rolling back makes the target revision the *newest* number (e.g. undoing from revision 4 to revision 3 produces revision 5).

> **💡 Exam Tip:** A broken image (e.g. a bad tag → `ImagePullBackOff` / `ErrImagePull`) is the classic rollback scenario. Use `rollout history --revision=N` to confirm which revision has the good image before running `rollout undo --to-revision=N`.

*Source: Managing Kubernetes Controllers and Deployments — Pausing and Rolling Back Deployments / Workloads and Scheduling for CKA — Rollback and Revision History*

---

## 4. ConfigMaps and Secrets

Decouple configuration from code (twelve-factor app, factor 3: *store config in the environment, not in code*). **ConfigMaps** hold non-sensitive data (URLs, domains); **Secrets** hold sensitive data (passwords, tokens, keys). Both can be injected two ways:

1. **Environment variables** — best for small values; **no hot reload** (must restart the pod to pick up changes).
2. **Volume mounts** — best for larger config (e.g. a web server config file); **supports hot reloading** when you reference a whole directory (not a single file).

### ConfigMaps

```bash
k create configmap web-env-config --from-literal=ENV_NAME=pluralsight-dev --from-literal=APP_MODE=TEST
k create configmap web-html --from-file=index.html
k get cm web-env-config
```

As env vars:
```yaml
    envFrom:
    - configMapRef:
        name: web-env-config
```
As a volume (enables hot reload):
```yaml
    volumeMounts:
    - name: html-dir
      mountPath: /usr/share/nginx/html
  volumes:
  - name: html-dir
    configMap:
      name: web-html
```

### Secrets

```bash
k create secret generic db-pass --from-literal=DB_PWD='K8sRocks!'
k get secret db-pass -o yaml          # values are Base64-encoded
echo <value> | base64 -d             # decode
```
```yaml
    envFrom:
    - secretRef:
        name: db-pass
```

Secret types: **Opaque** (default), `kubernetes.io/service-account-token`, `kubernetes.io/dockercfg` & `dockerconfigjson` (registry creds), `kubernetes.io/basic-auth`, `kubernetes.io/ssh-auth`, `kubernetes.io/tls` (needs `tls.key` + `tls.crt`), and bootstrap tokens. You may define custom types using the convention `domain.com/typename`.

**Security:** Secrets are only **Base64-encoded** (obscured, not encrypted) and are stored in etcd. Anyone with API/etcd access, or who can create a pod (including indirectly via a Deployment) in a namespace, can read its Secrets. Hardening: enable **encryption at rest** for etcd, apply **RBAC least privilege** (restrict `get`/`watch`/`list` on secrets), mount a Secret only into the single container that needs it, and consider an external provider (e.g. HashiCorp Vault).

> **💡 Exam Tip:** Use environment variables for short values (a password) and **volume mounts referencing a directory** when you need hot reload (e.g. updating `index.html` via `kubectl edit cm`). Remember Base64 ≠ encryption.

*Source: Workloads and Scheduling for CKA — Configuration and Decoupling / Managing Secrets*

---

## 5. Horizontal Pod Autoscaling (HPA)

Three autoscaling controllers exist, but the CKA focuses on **HPA** (the others must be installed separately and are out of scope):

- **HPA (Horizontal Pod Autoscaler)** — built into the kube-controller-manager; changes the *number of replicas* of a Deployment or StatefulSet based on metrics (CPU/memory) from the **metrics server**.
- **VPA (Vertical Pod Autoscaler)** — adjusts CPU/memory *requests* per pod; not built-in.
- **CA (Cluster Autoscaler)** — adds/removes *nodes* via the cloud provider; not built-in.

HPA is a control loop: it queries the metrics server, compares actual usage to your target, and scales by a ratio. If target is 50% CPU and pods are at 100%, it doubles the replicas to bring the average back to 50%. It requires **resource requests** defined on the pods. To prevent **flapping** (rapid scale up/down), HPA uses a **stabilization window** (default 5 minutes) before scaling down.

```bash
k autoscale deployment hello-world --cpu-percent=50 --min=1 --max=10
k get hpa     # TARGETS column shows current/target, e.g. 0%/50%
```

> **💡 Exam Tip:** HPA does nothing without resource **requests** on the target pods and a running metrics server — a `<unknown>` value in the TARGETS column means metrics aren't available yet. HPA scales replicas; VPA scales requests; CA scales nodes.

*Source: Workloads and Scheduling for CKA — Autoscaling Workloads / Demo: Configuring HPA*

---

## 6. Self-Healing and Container Probes

A pod is "ready" when all its containers are running, but probes give Kubernetes deeper insight into application health. All three probe types are **per-container** settings.

- **livenessProbe** — continuously checks if the container is healthy. **On failure the kubelet restarts the container** per the restart policy. Use to recover a hung/crashed app.
- **readinessProbe** — checks if the container is ready to receive traffic. **On failure the pod's IP is removed from Service endpoints** (no restart) so users don't hit a broken pod. Also gates deployment rollouts.
- **startupProbe** — checks during startup for slow-starting apps. While it runs, liveness/readiness probes are **disabled**; once it succeeds they take over. **On failure the kubelet restarts the container.**

**Diagnostic check types:** `exec` (command exit code 0 = success), `tcpSocket` (can open the TCP port), `httpGet` (HTTP status ≥200 and <400 = success).

**Tuning fields:** `initialDelaySeconds` (default 0), `periodSeconds` (interval), `timeoutSeconds`, `failureThreshold` (default 3), `successThreshold` (default 1).

```yaml
    livenessProbe:
      tcpSocket:
        port: 8080
      initialDelaySeconds: 15
      periodSeconds: 20
    readinessProbe:
      httpGet:
        path: /index.html
        port: 8080
      initialDelaySeconds: 5
      periodSeconds: 10
```

**Container restart policy** (pod-level): `Always` (default, for long-running workloads), `OnFailure` (for Jobs), `Never`. It governs how the kubelet restarts containers, including after a liveness/startup probe failure.

> **💡 Exam Tip:** Liveness failure → **restart** the container; readiness failure → **remove from Service endpoints** (no restart). Use a **startupProbe** for apps with long startup times instead of inflating liveness `initialDelaySeconds`.

*Source: Managing the Kubernetes API Server and Pods — Defining Pod Health: livenessProbes, readinessProbes and startupProbes*

---

## 7. Pod Admission and Scheduling

### Resource requests and limits (admission)

In the pod's `resources` block:
- **requests** — *guaranteed* resources; the scheduler uses these to find a node with enough spare capacity. If none matches, the pod stays **Pending**.
- **limits** — the hard ceiling. Exceeding the **CPU** limit → the container is **throttled**. Exceeding the **memory** limit → the kernel kills it → **OOMKilled**.

**Quality of Service (QoS)** classes (determine eviction priority under pressure):
- **Guaranteed** (highest) — requests == limits for both CPU and memory.
- **Burstable** — requests < limits.
- **BestEffort** (lowest, evicted first) — no requests/limits defined.

```yaml
    resources:
      requests:
        cpu: "500m"
        memory: "5Mi"
      limits:
        cpu: "500m"
        memory: "10Mi"
```

> **💡 Exam Tip:** Setting requests == limits for both CPU and memory yields **Guaranteed** QoS (protected longest under memory pressure). No requests/limits = **BestEffort** (evicted first). Memory over-limit = OOMKilled; CPU over-limit = throttled (not killed).

*Source: Workloads and Scheduling for CKA — Configuring Pod Admission*

### nodeSelector

Simplest placement control: label a node, then require that exact key/value in the pod's `nodeSelector`. If no node matches, the pod stays **Pending**.

```bash
k label node minikube-m02 disk=ssd
```
```yaml
spec:
  nodeSelector:
    disk: ssd
```

### Node affinity / anti-affinity

An evolved nodeSelector supporting operators and **soft (preferred) rules**:
- `requiredDuringSchedulingIgnoredDuringExecution` — hard rule (like nodeSelector).
- `preferredDuringSchedulingIgnoredDuringExecution` — soft rule; scheduler tries the preferred node but will place the pod elsewhere if that node is full.

### Pod affinity / anti-affinity

Schedule pods relative to *other pods*. **Pod anti-affinity** spreads replicas across nodes for high availability (don't co-locate two replicas of the same app). **Pod affinity** co-locates pods (e.g. a backend with its database on the same node), using a `topologyKey` such as `kubernetes.io/hostname`.

```yaml
spec:
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
      - labelSelector:
          matchLabels:
            app: webserver
        topologyKey: kubernetes.io/hostname
```

> **💡 Exam Tip:** `nodeSelector` and hard affinity leave pods **Pending** if nothing matches — check `kubectl get events` / `kubectl describe pod` for "didn't match node selector / affinity". Use **podAntiAffinity** to spread replicas for HA.

*Source: Workloads and Scheduling for CKA — Pod Scheduling / Demo: Pod Anti-affinity*

### Taints and tolerations

An *exclusionary* system: a **taint** on a node repels pods; a pod needs a matching **toleration** to be scheduled there. Used to reserve nodes or keep workloads off the control plane.

Taint effects:
- **NoSchedule** — no new pod without a toleration is scheduled.
- **PreferNoSchedule** — scheduler tries to avoid the node (soft).
- **NoExecute** — existing pods without a toleration are **evicted**.

```bash
k taint node minikube-m02 dedicated=special:NoSchedule
k taint node minikube-m02 dedicated=special:NoSchedule-   # remove (trailing dash)
```
```yaml
spec:
  tolerations:
  - key: dedicated
    operator: Equal
    value: special
    effect: NoSchedule
```

> **💡 Exam Tip:** A toleration **allows** a pod onto a tainted node but does not **force** it there — combine with nodeSelector/affinity to *require* placement. Control-plane nodes are tainted by default, which is why ordinary pods avoid them.

*Source: Workloads and Scheduling for CKA — Demo: Taints and Tolerations*

### Manual scheduling and static pods

- **Manual scheduling:** set `spec.nodeName: <node>` to bypass the scheduler entirely and bind a pod to a specific node.
- **Static pods:** pods managed directly by the **kubelet** on a node, not the API server. Drop a pod manifest into the **staticPodPath** (default `/etc/kubernetes/manifests`, configurable in `/var/lib/kubelet/config.yaml`). The kubelet watches that directory: adding a manifest starts the pod, editing it restarts the pod, removing it deletes the pod. The kubelet creates a read-only **mirror pod** so the static pod is *visible* via `kubectl get pods` but cannot be controlled through the API server. This is how control-plane components are launched by kubeadm.

> **💡 Exam Tip:** To create a static pod, SSH to the node and place the YAML in its `staticPodPath`; you cannot delete a static pod with `kubectl delete` (it returns) — remove the manifest file from the path instead. Mirror-pod names are suffixed with the node name.

*Source: Managing the Kubernetes API Server and Pods — Introducing and Working Static Pods*

### Pod Disruption Budgets (PDB)

PDBs protect against **voluntary** disruptions (node drain for maintenance, cluster upgrades, scaling down a pool) — not involuntary ones (hardware/network failure). Define a safety floor with `minAvailable` or `maxUnavailable`. If draining a node would violate the budget, the API server **blocks the eviction** until a replacement pod is running elsewhere.

```bash
k drain minikube-m02 --ignore-daemonsets
k uncordon minikube-m02
k create pdb nginx-protection --selector=app=pdb-app --min-available=3
```

> **💡 Exam Tip:** If `kubectl drain` hangs or errors with "cannot evict pod as it would violate the disruption budget," either scale the deployment up so the floor is met or adjust the PDB. PDBs only guard voluntary disruptions.

*Source: Workloads and Scheduling for CKA — Pod Disruption Budgets / Demo: Protect Pods with PDBs*

---

## 8. Admission Control Basics

Every API request passes through four phases: **connection → authentication → authorization → admission control**. An **admission controller** is code that intercepts a create/update/delete request *before* the object is persisted to etcd. It can **mutate** the request (add default values, apply quotas/standards) or **validate** it (reject malformed or non-compliant objects). For workloads, this is where resource quotas, LimitRanges defaults, and policy checks are enforced.

> **💡 Exam Tip:** Admission control runs *after* authn/authz but *before* persistence. Mutating controllers can inject defaults (e.g. LimitRange-supplied requests/limits); validating controllers can reject pods that violate resource quotas.

*Source: Managing the Kubernetes API Server and Pods — Anatomy of an API Request: A Closer Look / Kubernetes docs*
