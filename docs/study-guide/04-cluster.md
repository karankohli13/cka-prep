# CKA Study Guide — Cluster Architecture, Installation, and Configuration

> Domain weight: **25% of the CKA exam** (second-largest domain). The exam is 100% performance-based: you drive live kubeadm clusters under a two-hour clock, switching between ~6 clusters via contexts. Master kubeadm, RBAC, etcd backup/restore, and upgrades — these are classic CKA tasks.

---

## 1. Kubernetes Architecture

Kubernetes is an open-source platform for orchestrating containerized applications **at scale, in any environment**. It is **declarative** — you describe desired state in YAML, and Kubernetes continuously **reconciles** actual state toward it. Released by Google (2014), governed by the **CNCF** (the CKA exam sponsor) since 2015.

Mental model: **The control plane decides, the worker nodes execute, and everything flows through the API server.** This is a hub-and-spoke design — components never talk to each other directly; they all go through the API server.

### Control plane components

| Component | Role |
|---|---|
| **kube-apiserver** | The single front door to the cluster. Validates every request (kubectl, internal calls, webhooks) and persists state to etcd. No exceptions. |
| **etcd** | Distributed key-value store; the cluster's single source of truth (every pod, service, configmap, secret). Only the API server talks to etcd. Lose etcd without a backup and you lose the cluster. |
| **kube-scheduler** | Watches for unscheduled pods, evaluates resources/affinity/taints, and **picks a node**. It places pods; it does not run them. |
| **kube-controller-manager** | Runs reconciliation loops (deployment, replicaset, node, and dozens of other controllers) comparing desired vs. actual state and closing the gap. The self-healing engine. |

### Node components

| Component | Role |
|---|---|
| **kubelet** | The node agent that runs on every node (control plane and worker). Pulls pod specs from the API server and runs containers via the CRI. Restarts crashed containers. Watches `/etc/kubernetes/manifests` for static pods. |
| **kube-proxy** | Programs iptables or IPVS rules so service virtual IPs route to backend pods. Runs as a DaemonSet (one pod per node). |
| **container runtime** | Pulls images and runs containers. **containerd** is the default (Docker/dockershim removed in v1.24). |

### Static pods

The four control plane components run as **static pods** — the kubelet runs them directly from YAML files on disk in `/etc/kubernetes/manifests` (`kube-apiserver.yaml`, `etcd.yaml`, `kube-controller-manager.yaml`, `kube-scheduler.yaml`). No scheduler or deployment is involved. Edit one of these files and the kubelet detects the change and restarts the pod automatically. They use **host networking**, which is why they run even before a CNI is installed.

### CoreDNS

Cluster DNS runs as a Deployment (2 replicas for HA) in `kube-system`, fronted by a ClusterIP service named **kube-dns** at `10.96.0.10`. Every service gets a DNS name `<service>.<namespace>.svc.cluster.local`. Verify resolution with `nslookup kubernetes.default` from a busybox pod (pin `busybox:1.28` — newer tags have a broken nslookup).

> **💡 Exam Tip:** When something breaks, name the responsible component first — "the control plane decides, nodes execute, everything flows through the API server." Knowing which component owns a failure is 80% of troubleshooting. Static pods live in `/etc/kubernetes/manifests`; that directory is where you go when the exam says "the API server is misconfigured."

*Source: Kubernetes Foundations — Understanding Kubernetes architecture*

---

## 2. Extension Interfaces (CRI, CNI, CSI)

Kubernetes is modular by design: the control plane orchestrates but delegates compute, networking, and storage to pluggable interfaces. These are **plug-in boundaries, not implementations** — Kubernetes defines the interface; vendors supply plug-ins.

- **CRI (Container Runtime Interface)** — How the kubelet talks to the container runtime, over a gRPC contract. The kubelet speaks CRI; the runtime (containerd, CRI-O) implements it. Docker/dockershim was removed in v1.24.
- **CNI (Container Network Interface)** — How pods get IP addresses and pod-to-pod connectivity across nodes. Guarantees one pod / one IP with no NAT between pods. Examples: **Calico** (BGP + NetworkPolicy enforcement), **Flannel** (VXLAN overlay, no NetworkPolicy), **Cilium** (eBPF). Kubernetes ships no built-in CNI.
- **CSI (Container Storage Interface)** — How persistent storage is provisioned and attached. Storage vendors ship CSI drivers as separate deployments, independent of Kubernetes releases (storage drivers were removed from core).

> **💡 Exam Tip:** Naming the interface narrows the search space instantly. Container won't start → CRI/runtime. Pod has no IP → CNI. PersistentVolume stuck Pending → CSI/StorageClass.

*Source: Kubernetes Foundations — Kubernetes extension interfaces; CKA Advanced Cluster Configuration — The interface trifecta*

---

## 3. Preparing Infrastructure for kubeadm

Before `kubeadm init` runs, every node (control plane and workers, configured identically) must satisfy these prerequisites. One misconfigured node breaks the join workflow.

### System requirements
- Linux (Ubuntu in these courses; RHEL etc. also work). Windows worker nodes possible but out of scope.
- Minimum **2 CPUs and 2 GB RAM** per node (more for production workloads).
- Network connectivity between all nodes; **unique hostname and MAC address** per node.

### Swap disabled
The kubelet refuses to run with swap on (the scheduler needs accurate memory accounting).
```bash
sudo swapoff -a
# Remove/comment the swap line in /etc/fstab so it stays off after reboot
sudo sed -i '/ swap / s/^/#/' /etc/fstab
swapon --show   # empty output = swap is off
```

### Kernel modules
```bash
cat <<EOF | sudo tee /etc/modules-load.d/k8s.conf
overlay
br_netfilter
EOF
sudo modprobe overlay
sudo modprobe br_netfilter
lsmod | grep -E 'overlay|br_netfilter'
```
- **overlay** — enables OverlayFS, which containerd uses to stack image layers.
- **br_netfilter** — makes bridged Layer-2 traffic visible to iptables/netfilter (used by kube-proxy and CNI plug-ins).

`/etc/modules-load.d/k8s.conf` makes systemd auto-load the modules at every boot (persistence).

### sysctl parameters
```bash
cat <<EOF | sudo tee /etc/sysctl.d/k8s.conf
net.ipv4.ip_forward = 1
net.bridge.bridge-nf-call-iptables = 1
net.bridge.bridge-nf-call-ip6tables = 1
EOF
sudo sysctl --system
```
- `net.ipv4.ip_forward=1` — host becomes a Layer-3 forwarder so pods on different nodes can route to each other.
- `net.bridge.bridge-nf-call-iptables=1` — bridged traffic is visible to iptables (a hard kubeadm requirement). All three are `0` on stock Ubuntu and must be `1` before init.

### Install and configure containerd
```bash
sudo apt-get install -y containerd
sudo mkdir -p /etc/containerd
containerd config default | sudo tee /etc/containerd/config.toml
# CRITICAL: cgroup driver must match the kubelet's (systemd). #1 cause of init failures.
sudo sed -i 's/SystemdCgroup = false/SystemdCgroup = true/' /etc/containerd/config.toml
sudo systemctl restart containerd
sudo systemctl enable containerd
crictl info        # confirms the CRI socket is reachable
```
Set the crictl endpoint so it doesn't guess the socket:
```bash
cat <<EOF | sudo tee /etc/crictl.yaml
runtime-endpoint: unix:///run/containerd/containerd.sock
EOF
```

### Install and pin kubeadm, kubelet, kubectl
```bash
sudo apt-get install -y apt-transport-https ca-certificates curl gpg
curl -fsSL https://pkgs.k8s.io/core:/stable:/v1.34/deb/Release.key | \
  sudo gpg --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg
echo "deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/v1.34/deb/ /" | \
  sudo tee /etc/apt/sources.list.d/kubernetes.list
sudo apt-get update
sudo apt-get install -y kubelet kubeadm kubectl
sudo apt-mark hold kubelet kubeadm kubectl   # block apt from upgrading them
```
Install all three packages at the **same minor version on every node** — version skew between control plane and workers breaks the join. `apt-mark hold` is the documented defense against a routine `apt upgrade` silently bumping the version.

> **💡 Exam Tip:** The cgroup-driver mismatch (`SystemdCgroup`) is the single most asymmetric trap: 5 characters in a config file. Get it right and the cluster comes up in 90 seconds; get it wrong and the kubelet crash-loops with errors that point you at the wrong layer for hours. Also remember: the kubelet is `inactive (dead)` / crash-looping **before** `kubeadm init` — that's correct, it has no config yet.

*Source: Installing Clusters with kubeadm — Preparing Linux hosts; Using kubeadm to Install a Basic Cluster — Installation Requirements*

---

## 4. Creating a Cluster with kubeadm (init + join)

### What `kubeadm init` does (phases)
1. **preflight** — validates host (swap off, ports open, CRI running, resources).
2. **certs** — generates a self-signed **CA** (`/etc/kubernetes/pki/ca.key` signs everything) plus ~15 X.509 certificates for each control plane component and the kubelet.
3. **kubeconfig** — writes `admin.conf`, `controller-manager.conf`, `scheduler.conf`, `kubelet.conf` into `/etc/kubernetes` (root-only).
4. **kubelet-start** — writes the kubelet env file and starts the agent.
5. **control-plane** — writes the four static pod manifests to `/etc/kubernetes/manifests`.
6. **etcd** — initializes local etcd as a static pod (stacked topology).
7. **upload-config** — saves cluster config to the `kubeadm-config` ConfigMap in `kube-system` (authoritative source for podSubnet).
8. **bootstrap-token** — creates a token and prints the full `kubeadm join` command.
9. Applies add-ons: CoreDNS and kube-proxy.

### Running init
```bash
sudo kubeadm init \
  --pod-network-cidr=192.168.0.0/16 \
  --apiserver-advertise-address=192.168.50.10 \
  --control-plane-endpoint=k8s.example.local:6443 \
  --kubernetes-version=v1.34.0 \
  --upload-certs
```
Key flags:
- **`--pod-network-cidr`** — the IP block pods draw from. **Must match what your CNI expects** (Calico default `192.168.0.0/16`, Flannel `10.244.0.0/16`). A mismatch is a silent failure: pods get IPs but cross-node traffic times out — no clean error.
- **`--apiserver-advertise-address`** — routable interface workers connect to during join.
- **`--control-plane-endpoint`** — a DNS name (not just an IP) baked into every cert's SAN list. Set it now even on a single-node init so future HA is a config change, not a certificate reissue.
- **`--kubernetes-version`** — pin to the version the exam stem names.
- **`--upload-certs`** — stores control plane certs in a Secret (2-hour TTL) so additional control plane nodes join without manual SCP of certs.

Declarative alternative (preferred for HA): `kubeadm config print init-defaults > init.yaml`, edit `podSubnet`, `controlPlaneEndpoint`, `apiServer.certSANs`, then `kubeadm init --config init.yaml --upload-certs`.

### Set up kubectl access
`admin.conf` is root-only, so kubectl returns `connection refused` until you copy it:
```bash
mkdir -p $HOME/.kube
sudo cp -i /etc/kubernetes/admin.conf $HOME/.kube/config
sudo chown $(id -u):$(id -g) $HOME/.kube/config
```

### Install the CNI
After init, nodes are **NotReady** and CoreDNS is **Pending** — this is correct, not a failure. The kubelet won't mark a node Ready until a CNI can assign pod IPs. Install Calico (via Helm + Tigera operator is the v1.34 curriculum way):
```bash
helm repo add projectcalico https://docs.tigera.io/calico/charts
helm repo update
kubectl create namespace tigera-operator
helm install calico projectcalico/tigera-operator --namespace tigera-operator
# (older approach: kubectl create -f tigera-operator.yaml + custom-resources.yaml)
```
Nodes flip to Ready within ~30 seconds. The operator deploys the `calico-node` DaemonSet (one per node) plus `calico-kube-controllers`.

### Bootstrap tokens and `kubeadm join`
The join command uses **two-way verification**: a short-lived bootstrap token (`<6-char-id>.<16-char-secret>`, 24-hour TTL) authenticates the worker to the API server, and the **CA cert hash** (SHA-256) lets the worker confirm it's talking to the real control plane (anti-MITM).
```bash
# Run on a worker (needs sudo to write /etc/kubernetes/kubelet.conf):
sudo kubeadm join 192.168.50.10:6443 \
  --token <token> \
  --discovery-token-ca-cert-hash sha256:<hash>

# Regenerate the join command anytime from the control plane:
kubeadm token create --print-join-command
```
During join, the node submits a **CSR**; the CA auto-signs it; the kubelet cert lands in `/var/lib/kubelet/pki` and the kubeconfig at `/etc/kubernetes/kubelet.conf`.

### Six-point validation checklist after CNI install
1. `kubectl get nodes` — all Ready.
2. `kubectl get pods -n kube-system` (and `calico-system`) — all Running, CoreDNS no longer Pending.
3. DNS test: `kubectl run test --image=busybox:1.28 --rm -it --restart=Never -- nslookup kubernetes.default` → resolves `10.96.0.1`.
4. Cross-node ping: pin a pod to worker1, another to worker2, ping one from the other (0% loss).
5. `kubectl cluster-info` — healthy endpoints.
6. `kubectl get pods -A` — zero CrashLoopBackOff/Pending.

> **💡 Exam Tip:** The CNI/pod-CIDR mismatch is the #1 kubeadm gotcha and it fails silently. Memorize Calico's `192.168.0.0/16` and verify it matches your init config before anything else. The `kubeadm init` output is the most information-dense screen on the exam — copy the join command the moment it appears, or regenerate with `kubeadm token create --print-join-command`. A NotReady node right after a clean init = install/fix the CNI, not something more elaborate.

*Source: Installing Clusters with kubeadm — Bootstrapping with init and join; Using kubeadm to Install a Basic Cluster — Building Your Own Cluster*

---

## 5. kubeconfig (clusters, users, contexts)

A **kubeconfig** is a YAML file (default `~/.kube/config`) that bundles three things kubectl needs:
- **clusters** — API server endpoint + CA certificate.
- **users** — client credentials (certificate, token, or exec plugin).
- **contexts** — a named tuple of *cluster + user + default namespace*.

`kubectl` talks to the API server (over the network); `kubectl config` only reads/writes your **local** kubeconfig file — so config commands succeed even when the cluster is unreachable. That's why they're your first command after every question switch.

```bash
kubectl config get-contexts                 # lists contexts; active one marked *
kubectl config current-context              # verify which cluster you're on
kubectl config use-context <name>           # switch clusters (primary command)
kubectl config set-context --current --namespace=production   # set default namespace
```

> **💡 Exam Tip:** Context switching is the #1 CKA gotcha. Every task names a context — stop reading the task at the cluster name, run `use-context` + `current-context` to verify, *then* continue. Run a delete on the wrong cluster and that task scores 0. `kubectl config use-context` is a local file edit (the switch); `kubectl delete` hits the API server (the work) — two different surfaces.

*Source: Kubernetes Foundations — Context management; Using kubeadm to Install a Basic Cluster — kubeconfig files*

---

## 6. Role-Based Access Control (RBAC)

RBAC regulates access to the API server. The logic is: **who** (subject) can do **what** (verbs) on **which** resources. Kubernetes RBAC is **purely additive — there are no deny rules**. No matching binding = `403 Forbidden` (secure by default).

### Four resource types

| Resource | Scope | Purpose |
|---|---|---|
| **Role** | Namespaced | Set of permission rules within one namespace. |
| **ClusterRole** | Cluster-wide | Permissions for cluster-scoped resources (nodes, PVs, namespaces) OR a reusable permission template. |
| **RoleBinding** | Namespaced | Binds a Role (or a ClusterRole) to subjects within one namespace. |
| **ClusterRoleBinding** | Cluster-wide | Binds a ClusterRole to subjects across the entire cluster. |

A **rule** combines: **apiGroups** (`""` for core resources like pods/services; `apps` for deployments), **resources** (pods, configmaps...), and **verbs** (get, list, watch, create, update, patch, delete). `get` retrieves one object; `list` retrieves all of a type — the exam tests this distinction.

**Subjects** are Users, Groups, or **ServiceAccounts** (the identity pods use; a token is mounted into the pod's filesystem). Kubernetes has no User object — users come from external auth (certs/OIDC); RBAC only handles authorization.

**Built-in ClusterRoles:** `view` (read-only), `edit` (read/write workloads), `admin` (full namespace control), `cluster-admin` (everything — break-glass only).

**Hybrid binding:** bind a ClusterRole using a RoleBinding to grant those permissions only within one namespace (DRY pattern — define a library of permissions once, drop them into namespaces). **ClusterRole aggregation** lets a parent ClusterRole inherit rules from any ClusterRole matching a label selector.

### Imperative creation
```bash
kubectl create namespace dev-office
kubectl create role pod-reader --verb=get,list,watch --resource=pods -n dev-office
kubectl create rolebinding read-pods --role=pod-reader --user=developer-jane -n dev-office

kubectl create clusterrole storage-admin --verb=get,list,watch --resource=persistentvolumes
kubectl create clusterrolebinding storage-binding --clusterrole=storage-admin --user=storage-user

# Hybrid: built-in ClusterRole bound only inside a namespace
kubectl create rolebinding dev-view --clusterrole=view --user=dev-user -n dev-office
```

### Verifying access
```bash
kubectl auth can-i create pods                       # check your own access
kubectl auth can-i get pods --as=test-user -n test-space   # impersonate a subject
kubectl auth can-i delete pods --as=system:serviceaccount:default:kube-explorer
kubectl auth can-i --list --as=test-user -n test-space     # full effective permissions
```
Under the hood `can-i` sends a **SubjectAccessReview** to the API server. For debugging *why* a request was denied, raise verbosity: `kubectl get pods -v=6` (shows the URL/HTTP code), `-v=8` (shows headers, bearer token, and response body). A 403 error message tells you exactly the five fields to fix: **user, verb, resource, apiGroup, namespace**.

```yaml
# Role example
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  namespace: dev-office
  name: pod-reader
rules:
- apiGroups: [""]          # core API group
  resources: ["pods"]
  verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: read-pods
  namespace: dev-office
subjects:
- kind: User
  name: developer-jane
  apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: Role
  name: pod-reader
  apiGroup: rbac.authorization.k8s.io
```

> **💡 Exam Tip:** If the task mentions a specific namespace, start with a **Role**; if it says "all namespaces" or cluster-wide resources (nodes, PVs), use a **ClusterRole + ClusterRoleBinding**. After creating any binding, immediately run `kubectl auth can-i ... --as=<subject>` — yes means you're done, no means catch the mistake before the timer runs out. Never grant the default ServiceAccount API access; create a dedicated SA with least privilege.

*Source: CKA Advanced Cluster Configuration — Managing role-based access controls; Configuring and Managing Kubernetes Security — Securing Cluster Access*

---

## 7. Authentication, TLS & Certificates

Kubernetes secures nearly every internal interaction with TLS. The kubeadm-generated CA (`/etc/kubernetes/pki/ca.crt`) signs certs for the API server, control plane components, and each kubelet, used for both encryption (HTTPS) and authentication.

- **Service accounts** authenticate with a JWT token the API server injects into the pod (`/var/run/secrets/kubernetes.io/serviceaccount/`). If a pod doesn't need API access, disable token mounting: set `automountServiceAccountToken: false` on the Pod spec or ServiceAccount.
- **End users** authenticate via client **certificates** (CN = username) signed by the cluster CA, static tokens, or **OIDC** (delegating to an identity provider like Azure Entra, AWS IAM, Google Cloud Identity for MFA + short-lived tokens). Certificates can't be revoked individually — prefer OIDC + temporary tokens in production.
- **Certificate expiry:** `kubeadm certs check-expiration` lists every cert and days remaining. Certs rotate on `kubeadm upgrade`; a cluster that never upgrades will eventually fail.

> **💡 Exam Tip:** Setting `--control-plane-endpoint` to a DNS name at init time writes that name into every cert's SAN list — essential for HA, because a load balancer in front of multiple API servers will fail TLS verification if its name isn't in the SAN list. Eliminate static credentials, enforce least privilege via RBAC, and disable `automountServiceAccountToken` for workloads that don't call the API.

*Source: Configuring and Managing Kubernetes Security — Securing Cluster Access; Using kubeadm to Install a Basic Cluster — Certificate Authority's Role*

---

## 8. Highly-Available Control Plane

HA is about **automatic failover** when infrastructure fails — not backups. etcd uses the **Raft** consensus protocol with leader election. You need a **majority (quorum)** to make decisions: `Q = N/2 + 1`. Use **odd numbers** (3, 5, 7) of control plane nodes to avoid split-brain. A 3-node control plane tolerates losing 1 node; a 2-node cluster is *more* dangerous than 1 node (losing either node loses quorum). Lose quorum and the cluster freezes read-only to prevent corruption.

### Topologies
- **Stacked etcd** — each control plane node runs its own local etcd as a static pod. Cheaper, simpler; kubeadm manages etcd membership as you join nodes. Most common for medium clusters.
- **External etcd** — etcd runs on dedicated hosts, decoupled from the API servers. More hardware/complexity, highest stability; scale the API and etcd independently. Used for very large clusters.

### Load balancer
With multiple API servers you need one stable address. Use **HAProxy** (round-robin across the masters on port 6443) with **Keepalived** providing a **virtual IP** that floats to a surviving LB node if one fails. Point `--control-plane-endpoint` at this LB address.

```
# haproxy.cfg (concept)
frontend k8s-api
    bind *:6443
    default_backend k8s-masters
backend k8s-masters
    balance roundrobin
    server master1 10.0.0.11:6443 check
    server master2 10.0.0.12:6443 check
    server master3 10.0.0.13:6443 check
```
HAProxy's `check` parameter actively probes each master and routes only to healthy survivors.

### Bootstrap
```bash
# Primary: control-plane-endpoint = LB address, upload certs for automated handoff
sudo kubeadm init --control-plane-endpoint "k8s-lb:6443" --upload-certs --pod-network-cidr=192.168.0.0/16

# Additional control plane nodes use the --control-plane flag in the join command:
sudo kubeadm join k8s-lb:6443 --token <t> --discovery-token-ca-cert-hash sha256:<h> \
  --control-plane --certificate-key <key>
```

> **💡 Exam Tip:** HA protects against **infrastructure** failure, not **human** failure — an HA control plane will faithfully replicate an accidental `kubectl delete` to every node in milliseconds. That's why you still need etcd snapshots. The exam expects you to know the `--control-plane-endpoint` design move even if you never stand up full HA in the exam itself.

*Source: CKA Advanced Cluster Configuration — Configuring and managing a highly available control plane*

---

## 9. etcd Backup and Restore

etcd holds the entire cluster state, so a **snapshot** is your point-in-time recovery. You interact with etcd directly via `etcdctl`, **bypassing the API server** — critical because you must be able to recover even when the API server is down.

etcd requires full TLS auth, so every command passes three credentials plus the endpoint:

### Backup
```bash
ETCDCTL_API=3 etcdctl snapshot save /var/lib/etcd/snapshot.db \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key

ETCDCTL_API=3 etcdctl --write-out=table snapshot status /var/lib/etcd/snapshot.db
```
(If `etcdctl` isn't on the PATH, the binary is inside the etcd container; invoke via the runtime, or install `etcd-client`.)

### Restore (strict ordering)
You **cannot restore into a live database** — stop the control plane first.
```bash
# 1. Stop the control plane: move the static pod manifests out of the watch dir
sudo mv /etc/kubernetes/manifests/etcd.yaml /etc/kubernetes/manifests/kube-apiserver.yaml /tmp/

# 2. Restore the snapshot into a NEW, empty data directory (never the live one)
ETCDCTL_API=3 etcdctl snapshot restore /var/lib/etcd/snapshot.db \
  --data-dir=/var/lib/etcd-restored

# 3. Point etcd at the restored data: edit /etc/kubernetes/manifests/etcd.yaml
#    so the etcd-data volume hostPath = /var/lib/etcd-restored

# 4. Restart the control plane: move the manifests back
sudo mv /tmp/etcd.yaml /tmp/kube-apiserver.yaml /etc/kubernetes/manifests/

# 5. Verify
kubectl get nodes
kubectl get pods -A
```
The kubelet detects the manifest changes and re-creates the etcd/apiserver static pods automatically.

> **💡 Exam Tip:** Always restore to a **new** `--data-dir` — extracting a backup into the active directory corrupts running transaction tables. The full sequence (stop static pods → restore to new dir → update hostPath in etcd.yaml → restart) is a high-scoring CKA task. Remember the three TLS flags: `--cacert`, `--cert`, `--key`, and endpoint `127.0.0.1:2379`.

*Source: CKA Advanced Cluster Configuration — Disaster recovery / etcd backup and restore*

---

## 10. Cluster Lifecycle & Upgrades

Kubernetes has a defined upgrade process; you move between versions deliberately (that's why packages are `apt-mark hold`'d). **Upgrade order: control plane first, then worker nodes**, and only one minor version at a time (e.g., 1.33 → 1.34).

### Control plane node
```bash
# 1. Unhold and install the target kubeadm version
sudo apt-mark unhold kubeadm
sudo apt-get update && sudo apt-get install -y kubeadm=1.34.0-1.1
sudo apt-mark hold kubeadm

# 2. Plan and verify
sudo kubeadm upgrade plan

# 3. Apply (upgrades API server, controller-manager, scheduler, etcd; renews certs)
sudo kubeadm upgrade apply v1.34.0

# 4. Drain the node, then upgrade kubelet + kubectl
kubectl drain <cp-node> --ignore-daemonsets
sudo apt-mark unhold kubelet kubectl
sudo apt-get install -y kubelet=1.34.0-1.1 kubectl=1.34.0-1.1
sudo apt-mark hold kubelet kubectl
sudo systemctl daemon-reload && sudo systemctl restart kubelet

# 5. Uncordon
kubectl uncordon <cp-node>
```

### Worker nodes (repeat per node)
```bash
# On the worker: upgrade kubeadm, then apply the node-level upgrade
sudo apt-get install -y kubeadm=1.34.0-1.1
sudo kubeadm upgrade node

# From the control plane: drain the worker
kubectl drain <worker> --ignore-daemonsets --delete-emptydir-data

# On the worker: upgrade kubelet + kubectl and restart
sudo apt-get install -y kubelet=1.34.0-1.1 kubectl=1.34.0-1.1
sudo systemctl daemon-reload && sudo systemctl restart kubelet

# From the control plane: bring it back
kubectl uncordon <worker>
```

`kubectl drain` safely evicts pods (respecting PodDisruptionBudgets) and cordons the node; `--ignore-daemonsets` is required because DaemonSet pods can't be evicted. `cordon` marks unschedulable; `uncordon` reverses it.

> **💡 Exam Tip:** Upgrade order is always **control plane → workers**, one minor version at a time, never skipping versions. `kubeadm upgrade apply` runs on the first control plane node; `kubeadm upgrade node` runs on additional control plane nodes and on workers. Always `drain` before upgrading the kubelet and `uncordon` after. Match the `apt` package version (e.g., `1.34.0-1.1`) to the kubeadm version exactly.

*Source: Installing Clusters with kubeadm — version skew & apt-mark hold; Kubernetes docs — Upgrading kubeadm clusters (v1.34)*

---

## 11. Helm and Kustomize

Both solve configuration drift when deploying the same app across many environments — required for CI/CD and tested on the CKA.

### Helm — the package manager
A **chart** is a versioned package: `Chart.yaml` (metadata), `templates/` (manifests with Go templating), and `values.yaml` (variables injected at runtime). A **release** is a specific running instance of a chart. Helm tracks release history, enabling rollback.
```bash
helm repo add bitnami https://charts.bitnami.com/bitnami
helm repo update                                  # like apt-get update
helm search repo bitnami/apache                   # CHART VERSION vs APP VERSION
helm show values bitnami/apache > my-values.yaml  # inspect/customize variables
helm install my-web bitnami/apache -f my-values.yaml
helm upgrade my-web bitnami/apache -f my-values.yaml
helm rollback my-web 1                             # return to a known-good release
helm uninstall my-web                              # removes every resource in the release
```

### Kustomize — template-less overlays
Built into kubectl (`-k` flag). A **base** holds plain Kubernetes manifests + `kustomization.yaml`; **overlays** (dev/staging/prod) contain only the differences, merged via **strategic merge patch**. No templating language — what you see is what you get. Generators can build ConfigMaps/Secrets from files (appending a content hash to trigger rolling updates).
```bash
kubectl kustomize overlays/dev      # render the compiled YAML (audit before applying)
kubectl apply -k overlays/dev       # build + apply in one step
kubectl delete -k overlays/dev
```
An overlay's `kustomization.yaml` typically sets a `namePrefix` (e.g., `dev-`), references the base `resources`, and declares a targeted `patches` block (e.g., replicas: 3).

> **💡 Exam Tip:** The exam's locked-down browser includes the Helm docs. Helm = templating/packaging with rollback; Kustomize = overlay/patch with no template language and is native to `kubectl -k`. Distinguish CHART VERSION (the package) from APP VERSION (the software inside the container). The v1.34 curriculum prefers Helm/Kustomize over raw `kubectl apply -f` blobs for installing cluster components.

*Source: CKA Advanced Cluster Configuration — Templating with Helm / Layering with Kustomize*

---

## 12. CRDs and Operators

A **CustomResourceDefinition (CRD)** extends the Kubernetes API with your own object types (e.g., `Certificate`, `Database`) that behave like native resources — manageable with the same kubectl commands and RBAC. Out of the box, `kubectl get certificates` fails until a CRD registers that type. A CRD by itself is just passive data stored in etcd.

An **operator** is a custom controller running in the cluster that watches your CRDs and runs the **control loop**: observe current state → compare to desired state → act to close the gap. Operators automate **day-2 operations** (backups, failovers, version upgrades) — a site-reliability engineer encoded in software.

```bash
# Installing an operator registers CRDs + deploys the controller
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.x/cert-manager.yaml
kubectl get crds | grep cert-manager      # challenges, issuers, certificates...
kubectl get certificates                   # now returns "No resources found" instead of an error
kubectl get pods -n cert-manager           # controller, webhook, cainjector running
```
The Tigera/Calico install you used for the CNI is itself the operator pattern: the operator reads an `Installation` custom resource and reconciles Calico's components.

> **💡 Exam Tip:** Sequence to remember: a CRD adds the *vocabulary* (a new resource type in etcd); the operator/controller adds the *intelligence* (the reconciliation loop that acts on it). The v1.34 curriculum explicitly tests installing and configuring operators and understanding CRDs.

*Source: CKA Advanced Cluster Configuration — CRDs and the operator pattern; Installing Clusters with kubeadm — Tigera operator*

---

## 13. kubectl Workflow Essentials (exam speed)

- **Imperative** creation is fast for simple resources: `kubectl run`, `kubectl create deployment web --image=nginx --replicas=3`, `kubectl expose deployment web --port=80 --target-port=8080`, `kubectl scale deployment web --replicas=5`.
- **dry-run → YAML pipeline** for anything imperative can't express: `kubectl create deployment web --image=nginx --dry-run=client -o yaml > deploy.yaml`, edit, then `kubectl apply -f deploy.yaml`.
- **kubectl explain** is your offline API reference: `kubectl explain pod.spec.containers`, `kubectl explain deployment --recursive`.
- **Diagnostic ladder** (troubleshooting = 30% of the exam): `kubectl get` → `kubectl describe` → `kubectl logs` → events → `journalctl -u kubelet` → `crictl ps`. Most questions resolve at describe/events.
- Aliases save time: `alias k=kubectl`, plus `po`/`svc`/`deploy`/`ns` shortnames.

> **💡 Exam Tip:** Use imperative first, fall back to YAML only when required. `--dry-run=client -o yaml` is the single most valuable command — it generates a 100% syntactically correct manifest you edit, eliminating indentation errors. Every minute saved authoring YAML is a minute spent verifying.

*Source: Kubernetes Foundations — Mastering kubectl workflows; Working with Your Cluster — Using kubectl*
