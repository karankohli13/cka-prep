# Troubleshooting Kubernetes — CKA Study Guide

*The Troubleshooting domain is 30% of the CKA exam — the largest single domain. It is heavily command- and scenario-driven. Master the systematic workflow, then drill the specific symptom-to-fix patterns below.*

---

## 1. The Systematic Troubleshooting Workflow

Things break in Kubernetes constantly — pods crash, images fail to pull, services can't connect. The difference between a strong operator and a struggling one is not *whether* problems happen, but how quickly and systematically they are diagnosed. Always apply the same repeatable workflow rather than guessing.

**The 6-step workflow:**

1. **Observe** — `kubectl get pods` (add `-o wide`, `-A`, `--watch`). What is the symptom? Which pods/nodes are affected?
2. **Describe** — `kubectl describe pod <pod>`. Read the detailed status, conditions, and **Events** at the bottom.
3. **Logs** — `kubectl logs <pod>` (add `--previous`, `-c <container>`). What is the application itself reporting?
4. **Events** — `kubectl get events --sort-by=.metadata.creationTimestamp` for cluster-level messages from Kubernetes itself.
5. **Fix** — make the change: update the manifest, fix resources, correct the config.
6. **Verify** — confirm pods are `Running` and the application is healthy.

The key is staying calm, being systematic, and letting `kubectl` guide you to the problem. Most answers live in `kubectl describe` (Events) and `kubectl logs`.

> **💡 Exam Tip:** When a question gives you a symptom, mentally run the workflow in order. The exam rewards `describe` → read Events → `logs --previous`. The Events section of `kubectl describe pod` is the single highest-yield place to look — it tells you scheduling failures, image pull errors, OOM kills, and probe failures.

*Source: Maintaining, Monitoring, and Troubleshooting Kubernetes — Kubernetes Troubleshooting Workflow*

---

## 2. Troubleshooting Clusters and Nodes

### Node states and conditions

A node that is unhealthy shows up as **NotReady** in `kubectl get nodes`. Investigate with `kubectl describe node <node>`, which surfaces node **Conditions** and capacity:

```bash
kubectl get nodes                 # quick health overview
kubectl get nodes -o wide         # IPs, OS, kubelet version
kubectl describe node <node>      # Conditions, Capacity, Allocatable, Events
kubectl top nodes                 # live CPU/memory usage (needs metrics-server)
```

Key node **Conditions** (the `status` of each is `True`, `False`, or `Unknown`):

| Condition | Healthy value | Meaning when problematic |
|-----------|---------------|--------------------------|
| `Ready` | `True` | `False`/`Unknown` = node not accepting pods |
| `MemoryPressure` | `False` | `True` = node low on memory (may evict pods) |
| `DiskPressure` | `False` | `True` = node low on disk |
| `PIDPressure` | `False` | `True` = too many processes |
| `NetworkUnavailable` | `False` | `True` = node network not configured |

When `Ready` is `Unknown`, the control plane has stopped hearing from the node's kubelet (a heartbeat/networking problem). When it is `False`, the kubelet is reporting itself unhealthy.

### The kubelet

The kubelet runs on every node and is the agent that talks to the API server and manages pods. A NotReady node is very often a kubelet problem. The kubelet runs as a **systemd service**, so debug it on the node itself:

```bash
systemctl status kubelet          # is it running?
sudo systemctl restart kubelet    # restart after fixing config
journalctl -u kubelet             # full kubelet logs
journalctl -u kubelet -f          # follow live
journalctl -u kubelet --since "10 min ago"
```

Common kubelet failure causes: bad `/var/lib/kubelet/config.yaml`, expired certificates, the container runtime being down, a full disk, or swap being enabled (kubelet refuses to start with swap on unless explicitly configured).

> **💡 Exam Tip:** If a node is `NotReady`, SSH to that node and run `systemctl status kubelet` first. If the kubelet is dead, `journalctl -u kubelet` almost always shows the root cause. Remember the kubelet is a **host systemd service**, not a pod — you cannot `kubectl logs` it.

*Source: Kubernetes docs — Troubleshoot Clusters and Nodes*

### The container runtime and crictl

The kubelet talks to a CRI-compatible container runtime (containerd, CRI-O) over a socket. If the runtime is down, the kubelet cannot start any containers and the node goes NotReady:

```bash
systemctl status containerd
crictl ps                         # running containers (CRI-level)
crictl ps -a                      # all containers including exited
crictl pods                       # pod sandboxes
crictl logs <container-id>        # logs of a CRI container
crictl images                     # images on the node
```

`crictl` is the CRI debugging CLI — use it on a node when `kubectl` is unavailable (e.g., when the control plane itself is broken). It reads the runtime directly via the CRI socket (commonly `unix:///run/containerd/containerd.sock`).

> **💡 Exam Tip:** `crictl` is the node-level equivalent of `docker`/`kubectl` for inspecting containers via the CRI. Use `crictl ps` and `crictl logs` when the API server is down and you cannot use `kubectl`. Don't reach for `docker` on modern clusters — containerd/CRI-O are standard.

*Source: Kubernetes docs — Container Runtime / crictl*

---

## 3. Troubleshooting Cluster Components (Control Plane)

### Static pods and /etc/kubernetes/manifests

On a kubeadm cluster, the core control plane components run as **static pods** managed directly by the kubelet (not by the API server / scheduler). Their manifests live on the control plane node at:

```
/etc/kubernetes/manifests/
├── etcd.yaml
├── kube-apiserver.yaml
├── kube-controller-manager.yaml
└── kube-scheduler.yaml
```

The kubelet **watches this directory**: editing a manifest causes the kubelet to recreate that static pod automatically. There is no need to `kubectl apply` — just edit the file and save. This is also how you fix a broken control plane component (e.g., a bad flag on the API server).

```bash
# View / fix a control plane component
sudo vi /etc/kubernetes/manifests/kube-apiserver.yaml
# kubelet automatically restarts the static pod on save

# Mirror pods of static pods appear in kube-system
kubectl get pods -n kube-system
```

### Checking control plane health

```bash
kubectl get pods -n kube-system               # all control plane + addon pods
kubectl get componentstatuses                 # (deprecated) scheduler/controller/etcd health
kubectl cluster-info                          # endpoint reachability
kubectl describe pod -n kube-system kube-apiserver-<node>
kubectl logs -n kube-system kube-scheduler-<node>
```

If the **API server itself is down**, `kubectl` will not work at all. Fall back to node-level tools:

```bash
crictl ps                                     # find the apiserver container
crictl logs <apiserver-container-id>
sudo journalctl -u kubelet                    # kubelet logs show static pod failures
sudo cat /var/log/pods/...                    # static pod stdout/stderr on disk
```

### etcd

etcd is the cluster's key-value store — every Deployment, Service, and ConfigMap lives there. Before any risky operation (especially upgrades), **back up etcd**:

```bash
ETCDCTL_API=3 etcdctl snapshot save /backup/etcd-snapshot.db \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key

ETCDCTL_API=3 etcdctl snapshot status /backup/etcd-snapshot.db
```

> **💡 Exam Tip:** Control plane components are static pods in `/etc/kubernetes/manifests/`. To fix a crashed apiserver/scheduler/controller-manager, edit its manifest file on the control plane node — the kubelet auto-recreates the pod. If `kubectl` is dead, use `crictl ps` + `crictl logs` and `journalctl -u kubelet`. Always know how to take an etcd snapshot.

*Source: Maintaining, Monitoring, and Troubleshooting Kubernetes — Preparing for / Upgrading a Kubernetes Cluster; Kubernetes docs — Troubleshoot Cluster Components*

---

## 4. Troubleshooting Pod Failures

Pod issues are the most common exam scenarios. Each state has a distinct symptom and root cause, but the same workflow (`get` → `describe` → `logs`) finds them all.

### 4.1 Pending — pod won't schedule

**Symptom:** pod stuck in `Pending`, never gets a node.
**Cause:** the scheduler cannot find a node that fits — typically **insufficient CPU/memory**, unsatisfiable node selector/affinity, taints without tolerations, or no available PVC.

```bash
kubectl get pods                       # shows Pending
kubectl describe pod <pod>             # Events: "0/3 nodes available: Insufficient cpu"
kubectl describe nodes                 # check Allocatable CPU/memory per node
kubectl top nodes                      # live capacity
```

In the course demo, a pod requested `8` CPUs while each node had only ~2 cores — `describe pod` showed **"Insufficient cpu"** and no node could schedule it. Fix: lower the resource request to fit the nodes (or add capacity / a bigger node).

```yaml
resources:
  requests:
    cpu: "500m"      # was "8" — too large for the nodes
    memory: "128Mi"
```

> **💡 Exam Tip:** `Pending` = scheduling problem. Read the Events in `kubectl describe pod` — it states the exact reason: `Insufficient cpu`, `Insufficient memory`, `node(s) had untolerated taint`, `node(s) didn't match Pod's node affinity`, or `pod has unbound immediate PersistentVolumeClaims`.

*Source: Maintaining, Monitoring, and Troubleshooting Kubernetes — Troubleshooting Pending Pods*

### 4.2 ImagePullBackOff / ErrImagePull

**Symptom:** pod status `ErrImagePull` then `ImagePullBackOff`.
**Cause:** Kubernetes cannot pull the image — wrong image name/**tag**, image doesn't exist, private registry without `imagePullSecrets`, or registry unreachable.

```bash
kubectl get pods                       # ImagePullBackOff
kubectl describe pod <pod>             # Events: "Failed to pull image ... not found"
```

In the demo, the image tag was `99.99.99-nonexistent` — `describe pod` immediately showed the image could not be pulled. Fix: correct the image/tag to one that exists; for private registries, attach an `imagePullSecret`.

```yaml
spec:
  imagePullSecrets:
    - name: regcred
  containers:
    - name: app
      image: myrepo/app:1.2.3     # ensure tag actually exists
```

> **💡 Exam Tip:** `ImagePullBackOff` almost always means a typo in the image name/tag or a missing pull secret for a private registry. `kubectl describe pod` Events tells you exactly which image failed and why ("not found", "unauthorized", "no such host").

*Source: Maintaining, Monitoring, and Troubleshooting Kubernetes — Troubleshooting ImagePullBackOff*

### 4.3 CrashLoopBackOff — pod keeps crashing

**Symptom:** pod repeatedly starts then crashes; restart count climbs; state `CrashLoopBackOff`.
**Cause:** the container's process exits/errors on startup — bad config, missing dependency (e.g., a service it connects to), failing liveness probe, bad command, or a non-zero exit. `describe` often shows little; the **logs of the previous, crashed container** hold the answer.

```bash
kubectl get pods                       # CrashLoopBackOff, restart count rising
kubectl describe pod <pod>             # exit code, restart count, probe events
kubectl logs <pod> --previous          # KEY: logs from the crashed container instance
kubectl logs <pod> -c <container>      # for multi-container pods
```

In the demo, `describe` was inconclusive; `kubectl logs --previous` revealed a Redis connection error because `redisHost` pointed at a non-existent service. The correct service name (`guestbook-redis`) was found via `kubectl get svc`, then fixed. **`--previous` is essential** because the current container may already be gone.

> **💡 Exam Tip:** For `CrashLoopBackOff`, `kubectl logs <pod> --previous` is the money command — it shows why the *last* attempt died, even though the container has already restarted. Check the **exit code** in `describe` too: `0` = clean exit (maybe nothing to do), `1` = app error, `137` = SIGKILL (often OOM), `139` = segfault.

*Source: Maintaining, Monitoring, and Troubleshooting Kubernetes — Troubleshooting CrashLoopBackOff*

### 4.4 OOMKilled — out of memory

**Symptom:** container restarts repeatedly; `describe` shows `Reason: OOMKilled` and exit code `137`.
**Cause:** the container exceeded its **memory limit** and was killed by the kernel OOM killer.

```bash
kubectl get pods                       # restarts climbing
kubectl describe pod <pod>             # "Last State: Terminated, Reason: OOMKilled, Exit Code: 137"
```

In the demo, the memory limit was set to only `32Mi` — far too little for the app — so the container was repeatedly OOMKilled (and may produce no logs at all). Fix: raise the memory limit/request to a realistic value (or fix a memory leak in the app).

```yaml
resources:
  requests:
    memory: "128Mi"
  limits:
    memory: "256Mi"      # was 32Mi — too low
```

> **💡 Exam Tip:** `OOMKilled` + exit code `137` = the container hit its memory **limit**. Logs may be empty because the process is killed abruptly. The fix is raising `resources.limits.memory` (or fixing the leak). Note: hitting the **request** doesn't kill; exceeding the **limit** does.

*Source: Maintaining, Monitoring, and Troubleshooting Kubernetes — Troubleshooting OOMKilled*

### Pod status quick reference

| Symptom | Likely cause | Confirm with | Fix |
|---------|-------------|--------------|-----|
| `Pending` | Insufficient resources / taint / affinity | `describe pod` Events; `describe nodes` | Lower requests / add node / tolerate taint |
| `ImagePullBackOff` | Bad image/tag, missing pull secret | `describe pod` Events | Fix image; add `imagePullSecrets` |
| `CrashLoopBackOff` | App errors on start, bad config, probe | `logs --previous` | Fix config / dependency / command |
| `OOMKilled` (137) | Exceeded memory limit | `describe pod` Last State | Raise `limits.memory` |
| `ContainerCreating` (stuck) | Volume/secret/configmap missing, CNI issue | `describe pod` Events | Create the missing resource |
| `Completed`/`Error` (Job) | Container exited 0 / non-zero | `logs` | Depends on workload |

---

## 5. Monitoring Cluster and Application Resource Usage

### metrics-server and kubectl top

The **metrics-server** collects resource metrics (CPU/memory) from kubelets and exposes them via the Metrics API. It is what powers `kubectl top` and the Horizontal Pod Autoscaler. It is **not installed by default**.

```bash
# Install (Helm example from the course)
helm install metrics-server metrics-server/metrics-server -n kube-system

kubectl get pods -n kube-system | grep metrics-server   # verify it's Running

kubectl top nodes        # CPU cores, CPU %, memory bytes, memory % per node
kubectl top pods         # CPU/memory per pod
kubectl top pods -A      # across all namespaces
kubectl top pods --containers   # per-container breakdown
```

`kubectl top` gives a fast, high-level view: which nodes are hot, which pods are resource-hungry. It is basic but invaluable for confirming a `Pending` (no capacity) or investigating an `OOMKilled` (memory trend).

> **💡 Exam Tip:** If `kubectl top` returns `error: Metrics API not available`, **metrics-server is not installed or not ready** — that is the fix, not a node problem. `kubectl top` is the quick check for resource exhaustion; `describe nodes` shows Allocatable vs. requested.

*Source: Maintaining, Monitoring, and Troubleshooting Kubernetes — Kubernetes Metrics Server*

### Production observability (conceptual)

The three pillars of observability are **metrics** (numeric measurements over time — CPU, memory, request/error rates), **logs** (timestamped records of discrete events), and **traces** (request paths through a distributed system). For the CKA, metrics and logs matter most.

Production-grade stack covered in the course: **Prometheus** (time-series DB that *scrapes* metrics and provides PromQL + built-in alerting) and **Grafana** (visualization/dashboards across data sources). Metrics are useful at four levels: cluster, node, pod, and application (custom) level.

> **💡 Exam Tip:** Know the distinction conceptually: `metrics-server` (lightweight, powers `kubectl top` and HPA, no history) vs. **Prometheus** (full time-series DB, history, PromQL, alerting). The CKA exam tests `kubectl top` and `metrics-server`, not Prometheus/Grafana operations — but understand why each exists.

*Source: Maintaining, Monitoring, and Troubleshooting Kubernetes — Kubernetes Observability / Prometheus and Grafana*

---

## 6. Managing and Evaluating Container Output Streams (Logs)

### kubectl logs essentials

Containers should write to **stdout/stderr**; the kubelet captures those streams and `kubectl logs` reads them. This is the standard Kubernetes logging contract — applications should **not** write to log files inside the container.

```bash
kubectl logs <pod>                       # current container stdout/stderr
kubectl logs <pod> --previous            # logs from the PREVIOUS (crashed) instance
kubectl logs <pod> -c <container>        # specific container in a multi-container pod
kubectl logs -f <pod>                    # follow (stream) live
kubectl logs <pod> --tail=100            # last 100 lines
kubectl logs <pod> --since=1h            # last hour
kubectl logs -l app=frontend             # logs from all pods matching a label selector
kubectl logs <pod> --timestamps         # prepend timestamps
```

On the node, container logs are written to disk at:

```
/var/log/pods/<namespace>_<pod>_<uid>/<container>/*.log
/var/log/containers/<pod>_<namespace>_<container>-<id>.log   # symlinks
```

### Limitations of kubectl logs (why centralized logging exists)

- Only **one pod at a time** — tedious across many replicas.
- **Logs are lost when a pod is deleted/crashes** (only `--previous` keeps the *last* instance).
- **No cross-pod search** — can't query "all error logs from any backend pod in the last hour."
- **No retention** — logs exist only as long as the pod, and are rotated/discarded.
- **No correlation** with metrics.

The course solution: **Loki** (log aggregation with retention + LogQL) plus **Grafana Alloy** (a **DaemonSet** that runs on every node, collects all container logs, and ships them to Loki). Structured logging (JSON with fields like timestamp, level, event) makes logs queryable.

> **💡 Exam Tip:** `kubectl logs --previous` is the single most important logging flag for troubleshooting crashes. For multi-container pods you **must** use `-c <container>` or you'll get an error/ambiguous result. Applications log to **stdout/stderr** — that's the Kubernetes logging contract. Centralized logging (Loki/Alloy, EFK) exists because pod logs are ephemeral and per-pod.

*Source: Maintaining, Monitoring, and Troubleshooting Kubernetes — Centralized Logging in Kubernetes*

---

## 7. Troubleshooting Services and Networking

### The Service → Endpoints → Pod chain

A Service routes traffic to pods that match its **label selector**. Kubernetes builds an **Endpoints** (or EndpointSlice) object listing the IPs of the ready, matching pods. **If the selector doesn't match any pod labels, Endpoints is empty and the Service is a black hole** — connections fail even though everything looks "Running."

```bash
kubectl get svc                          # service exists? has a ClusterIP?
kubectl get endpoints <svc>              # ARE THERE ENDPOINT IPs? empty = no matching pods
kubectl get endpointslices -l kubernetes.io/service-name=<svc>
kubectl describe svc <svc>               # shows Selector and Endpoints
kubectl get pods --show-labels           # do pod labels match the selector?
```

In the course demo, the backend Service worked at first glance (pods `Running`) but the app showed "backend unavailable." `kubectl get endpoints` showed **nothing for the backend** — the Service **selector** used the wrong app name and did not match the pod labels. Fix: align the Service `selector` with the pod `labels`.

```yaml
# Service
spec:
  selector:
    app: guestbook-backend     # MUST match the pod template labels exactly
---
# Deployment pod template
metadata:
  labels:
    app: guestbook-backend
```

### DNS / CoreDNS troubleshooting

In-cluster DNS is provided by **CoreDNS** (pods in `kube-system`). Services are reachable at `<service>.<namespace>.svc.cluster.local`. DNS failures break service discovery cluster-wide.

```bash
kubectl get pods -n kube-system -l k8s-app=kube-dns   # CoreDNS pods Running?
kubectl logs -n kube-system -l k8s-app=kube-dns        # CoreDNS logs
kubectl get svc -n kube-system kube-dns                # the DNS ClusterIP (usually .10)

# Test DNS / connectivity from inside the cluster with a debug pod:
kubectl run tmp --image=busybox:1.28 --rm -it --restart=Never -- sh
#   nslookup kubernetes.default
#   nslookup <svc>.<namespace>.svc.cluster.local
#   wget -qO- http://<svc>.<namespace>:<port>

# Check a pod's resolv.conf
kubectl exec <pod> -- cat /etc/resolv.conf
```

### Connectivity test methodology

1. Confirm the Service exists and has the right port/`targetPort`.
2. `kubectl get endpoints <svc>` — **empty endpoints is the #1 networking bug** (selector mismatch or pods not Ready).
3. If endpoints exist, test from a debug pod: DNS resolve, then `curl`/`wget` the ClusterIP and a pod IP directly to isolate where it breaks.
4. Check `NetworkPolicy` — a policy may be silently dropping the traffic.
5. For external access, verify the `Service` type (`ClusterIP`/`NodePort`/`LoadBalancer`) and any `Ingress`.

> **💡 Exam Tip:** When a Service can't be reached, run `kubectl get endpoints <svc>` first. **Empty endpoints** means the Service selector doesn't match any ready pod labels (or pods aren't passing readiness) — the most common networking failure on the exam. Also verify `port` vs `targetPort` and that CoreDNS pods are healthy. Use a `busybox`/`nicolaka/netshoot` debug pod with `nslookup`/`wget` to isolate DNS vs routing.

*Source: Maintaining, Monitoring, and Troubleshooting Kubernetes — Troubleshooting Networking Issues; Kubernetes docs — Debug Services / DNS*

---

## 8. Cluster Maintenance: Draining, Cordoning, and Upgrades

### Cordon, drain, uncordon

Before maintaining a node (patching the OS, upgrading the kubelet), safely move workloads off it:

```bash
kubectl cordon <node>      # mark unschedulable — no NEW pods (existing keep running)
kubectl drain <node> --ignore-daemonsets --delete-emptydir-data
                           # evict all pods (respecting PodDisruptionBudgets), then it's safe to maintain
# ... perform maintenance / upgrade the node ...
kubectl uncordon <node>    # mark schedulable again
```

- `cordon` only stops *new* scheduling; `drain` evicts existing pods (and cordons).
- `--ignore-daemonsets` is almost always required (DaemonSet pods can't be rescheduled and would block the drain).
- `--delete-emptydir-data` is needed if pods use `emptyDir`.
- `--force` evicts unmanaged ("bare") pods that aren't backed by a controller.
- Drain respects **PodDisruptionBudgets (PDB)** — it will not evict pods past the budget, preserving availability.

### High availability building blocks

Three mechanisms keep apps online during voluntary disruptions:

- **Replicas** — multiple pods behind a Service give redundancy; if one crashes, others serve traffic.
- **PodDisruptionBudget (PDB)** — guarantees a minimum number of pods stay available during voluntary disruptions (drain, upgrade, scale-down). The eviction API rejects requests that would breach it.
- **Pod anti-affinity** — spreads pods across nodes so a single node failure doesn't take down the whole app.

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: guestbook-backend-pdb
spec:
  minAvailable: 3            # or use maxUnavailable
  selector:
    matchLabels:
      app: guestbook-backend
```

### Upgrading a cluster with kubeadm

**Order: control plane first, then worker nodes one at a time** (control plane supports older kubelets, never the reverse; never upgrade all workers at once).

**Pre-upgrade checks:** verify all nodes `Ready` and all `kube-system` pods running; **back up etcd**; review release notes for breaking changes / deprecated APIs.

**Control plane:**
```bash
# 1. update apt repo to the new minor version, then:
sudo apt-mark unhold kubeadm
sudo apt-get install -y kubeadm=1.34.2-*       # install new kubeadm
sudo apt-mark hold kubeadm
kubeadm version

sudo kubeadm upgrade plan                       # preview what changes
sudo kubeadm upgrade apply v1.34.2              # upgrade control plane components

# Then the kubelet + kubectl ON the control plane node:
sudo apt-mark unhold kubelet kubectl
sudo apt-get install -y kubelet=1.34.2-* kubectl=1.34.2-*
sudo apt-mark hold kubelet kubectl
sudo systemctl daemon-reload
sudo systemctl restart kubelet
```

**Each worker node (one at a time):**
```bash
kubectl cordon <worker>
kubectl drain <worker> --ignore-daemonsets --delete-emptydir-data   # run from a machine with kubectl
# SSH to the worker:
sudo apt-mark unhold kubeadm && sudo apt-get install -y kubeadm=1.34.2-* && sudo apt-mark hold kubeadm
sudo kubeadm upgrade node                       # worker uses 'upgrade node', not 'apply'
sudo apt-mark unhold kubelet kubectl && sudo apt-get install -y kubelet=1.34.2-* kubectl=1.34.2-* && sudo apt-mark hold kubelet kubectl
sudo systemctl daemon-reload && sudo systemctl restart kubelet
# Back on the admin machine:
kubectl uncordon <worker>
```

With replicas + PDB + anti-affinity, applications stay online throughout. If a **worker** upgrade fails, fix-and-retry or replace the node. If the **control plane** fails, stop and stabilize it before touching workers.

> **💡 Exam Tip:** Memorize the upgrade flow: control plane → `kubeadm upgrade apply <ver>`; workers → `kubeadm upgrade node`. Always `cordon` + `drain --ignore-daemonsets` a node before upgrading it, then `uncordon`. `kubeadm upgrade apply` is **control-plane only**; workers use `kubeadm upgrade node`. Back up etcd before starting.

*Source: Maintaining, Monitoring, and Troubleshooting Kubernetes — Kubernetes High Availability / Preparing for & Upgrading a Cluster*

---

## 9. Helm Basics (for context)

**Helm** is the package manager for Kubernetes (like apt/Homebrew). It packages manifests into a **chart** so configuration lives in one place and releases can be upgraded/rolled back with a single command.

Chart structure:
- `Chart.yaml` — required metadata (name, version, maintainers).
- `values.yaml` — configuration values (image tags, replica counts, resource limits).
- `templates/` — Go-templated Kubernetes manifests; Helm injects `values` to render final manifests.

```bash
helm repo add <name> <url> && helm repo update
helm install <release> <chart> -n <ns>
helm upgrade <release> <chart> -f values.yaml    # apply changed values
helm history <release>                            # list revisions
helm rollback <release> <revision>                # roll back (creates a NEW revision)
```

> **💡 Exam Tip:** Helm is lightly tested on CKA. Know that a **chart** = templates + `values.yaml` + `Chart.yaml`, `helm upgrade` applies changes, `helm rollback` reverts (as a new revision), and `helm history` lists revisions. Changing one value in `values.yaml` propagates across all templated manifests.

*Source: Maintaining, Monitoring, and Troubleshooting Kubernetes — Introduction to / Deploying / Upgrading with Helm*

---

## Appendix: High-Yield Command Cheat Sheet

```bash
# Workflow
kubectl get pods -o wide -A
kubectl describe pod <pod>                 # Events at the bottom = gold
kubectl logs <pod> --previous -c <ctr>
kubectl get events --sort-by=.metadata.creationTimestamp

# Nodes / kubelet (on the node)
kubectl describe node <node>
systemctl status kubelet
journalctl -u kubelet -f

# Control plane (on control plane node)
ls /etc/kubernetes/manifests/
kubectl get pods -n kube-system
crictl ps -a && crictl logs <id>

# Resources
kubectl top nodes
kubectl top pods -A --containers

# Networking
kubectl get endpoints <svc>
kubectl describe svc <svc>
kubectl get pods --show-labels
kubectl run tmp --image=busybox:1.28 --rm -it --restart=Never -- sh

# Maintenance
kubectl cordon/drain/uncordon <node>
sudo kubeadm upgrade apply v<ver>          # control plane
sudo kubeadm upgrade node                  # workers
```

*Source: Maintaining, Monitoring, and Troubleshooting Kubernetes — full course; Kubernetes docs*
