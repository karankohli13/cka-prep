# CKA Storage Study Guide (10% of exam)

This domain covers three competencies:
- Implement storage classes and dynamic volume provisioning
- Configure volume types, access modes, and reclaim policies
- Manage persistent volumes (PV) and persistent volume claims (PVC)

The CKA exam is a practical, hands-on, command-line test. Expect 2–3 storage tasks. Always set the correct context with `kubectl config use-context <name>` before starting a task, and remember you may keep one extra browser tab open on the official Kubernetes docs.

---

## Why Storage Matters in Kubernetes

By design, containers are **ephemeral**. When a pod is deleted, crashes, or is rescheduled to a different node, anything written to the container's writeable filesystem layer is lost forever. This is fine for **stateless** apps (e.g., an NGINX frontend) — Kubernetes just spins up an identical replacement. But **stateful** apps like databases are useless if they lose their data on every restart.

The purpose of the Kubernetes storage system is to provide stable, persistent storage for stateful workloads that is **completely independent of the pod lifecycle**.

- A **Volume** is simply a directory made accessible to the containers in a pod. Its lifecycle is tied to the pod — delete the pod and the volume is destroyed. Good for sharing data between containers in a pod, but does not solve persistence.
- A **PersistentVolume (PV)** decouples storage from the pod lifecycle.
- A **PersistentVolumeClaim (PVC)** is how a user/app requests storage.
- A **StorageClass** automates PV creation via dynamic provisioning.

> **💡 Exam Tip:** Know the distinction cold — a plain Volume dies with the pod, while a PV/PVC survives pod deletion, rescheduling, and node failure. Stateful workloads (databases, file uploads, log collectors) require PV/PVC, not plain volumes.

*Source: Storage for CKA — Introduction to Kubernetes Storage*

---

## Persistent Volumes and Persistent Volume Claims

### Concepts

- A **PersistentVolume (PV)** is a piece of storage in the cluster, treated as a cluster resource like a node or CPU. It is provisioned either by a cluster administrator (static) or by a StorageClass (dynamic), and its lifecycle is independent of any pod. PVs are implemented with plugins for backends like NFS, iSCSI, GCE Persistent Disk, or AWS EBS.
- A **PersistentVolumeClaim (PVC)** is a request for storage by a user/application — "I need 5Gi that I can write to" — without needing to know the underlying infrastructure.
- The Kubernetes control plane acts as a **matchmaker**: it looks at the PVC's requirements (size, access mode, storage class) and finds/provisions a suitable PV, then **binds** them. Binding is a **1-to-1** mapping.
- Once bound, any pod referencing the PVC mounts it like a normal volume.

### PV Phases (Lifecycle)

| Phase | Meaning |
|-------|---------|
| **Available** | Free, not yet bound to any claim |
| **Bound** | Successfully matched and in use by a PVC |
| **Released** | The PVC was deleted, but the PV is not yet reclaimed/available for a new claim |
| **Failed** | The volume encountered an error |

### Static PV example (hostPath)

```yaml
apiVersion: v1
kind: PersistentVolume
metadata:
  name: my-pv
spec:
  capacity:
    storage: 2Gi
  accessModes:
    - ReadWriteOnce
  hostPath:
    path: /data/my-pv
```

`hostPath` points to a directory on the node — good for single-node/local testing, not production.

### PVC example (static binding)

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: my-pvc
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 2Gi
  storageClassName: ""   # empty string disables dynamic provisioning
```

Leaving `storageClassName` **unset/empty** disables dynamic provisioning so the PVC binds to a pre-existing static PV.

### Pod consuming a PVC

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: storage-test-pod
spec:
  containers:
    - name: nginx
      image: nginx
      volumeMounts:
        - name: data
          mountPath: /usr/share/nginx/html
  volumes:
    - name: data
      persistentVolumeClaim:
        claimName: my-pvc
```

### Key commands

```bash
kubectl apply -f pv.yaml
kubectl apply -f pvc.yaml
kubectl get pv                 # check status: Available/Bound/Released
kubectl get pvc                # check status: Bound/Pending
kubectl describe pvc my-pvc
```

> **💡 Exam Tip:** After creating a PV+PVC, always verify with `kubectl get pv` and `kubectl get pvc` that both show **Bound**, and confirm the PV's CLAIM column shows `<namespace>/<pvc-name>`. For static provisioning, set `storageClassName: ""` on both PV and PVC so they bind to each other instead of triggering dynamic provisioning. Deleting the pod does NOT delete the PVC or PV — the data persists.

*Source: Storage for CKA — Persistent Volumes and Claims*

---

## Volume Types and Access Modes

### Volume types

Kubernetes supports many volume types, from node-local storage to network and cloud storage:

- **emptyDir** — scratch space created when a pod is assigned to a node; deleted with the pod. Useful for sharing data between containers in the same pod.
- **hostPath** — mounts a directory from the node's filesystem. Single-node/testing.
- **configMap** / **secret** — inject config data or secrets as files into a pod.
- **nfs** — network file system, supports multi-node read-write.
- **awsElasticBlockStore (EBS)**, **gcePersistentDisk** — cloud block storage, typically attachable to a single node at a time.
- **persistentVolumeClaim** — mounts a bound PVC.

The underlying storage technology dictates which **access modes** are supported. For example, cloud block storage can usually attach to only one node at a time, limiting it to ReadWriteOnce.

### emptyDir snippet

```yaml
spec:
  containers:
    - name: app
      image: nginx
      volumeMounts:
        - name: cache
          mountPath: /cache
  volumes:
    - name: cache
      emptyDir: {}
```

### Access modes

Access modes define read/write permissions and sharing across nodes. **Note: they are scoped to nodes, not pods.**

| Mode | Short | Meaning |
|------|-------|---------|
| **ReadWriteOnce** | RWO | Mounted read-write by a **single node**. Multiple pods on that same node can use it simultaneously. Most common and widely supported. |
| **ReadOnlyMany** | ROX | Mounted read-only by **many nodes** at once. Good for shared static content/config. |
| **ReadWriteMany** | RWX | Mounted read-write by **many nodes** simultaneously. Most flexible; requires a backend that supports it (e.g., NFS, distributed FS). |
| **ReadWriteOncePod** | RWOP | Mounted read-write by a **single pod** only (stricter than RWO). *(Kubernetes docs — newer mode.)* |

> **💡 Exam Tip:** The classic trap: **ReadWriteOnce means a single NODE, not a single pod.** Multiple pods on the same node can share an RWO volume; pods on different nodes cannot. If a second pod on a different node gets stuck in `ContainerCreating` with a `FailedMount` event, that's an RWO volume being requested from another node — switch the backing storage to ReadWriteMany if multi-node access is needed.

*Source: Storage for CKA — Volume Types and Access Modes*

---

## Reclaim Policies

The **reclaim policy** controls what happens to a PV (and the underlying storage) after its claim is released.

| Policy | Behavior |
|--------|----------|
| **Retain** | Default/safest for static PVs. When the PVC is deleted, the PV is **not** deleted — it goes to **Released**. The underlying data is left untouched; an admin must manually inspect, back up, and clean it up before reuse. |
| **Delete** | When the PVC is deleted, the PV object **and** the underlying storage asset (e.g., AWS/GCE disk) are deleted — data is gone forever. Default for dynamic provisioning. Good for scratch/temporary data. |
| **Recycle** | **Deprecated.** Performed a basic `rm -rf` on the volume contents for reuse. Do not use — replaced by dynamic provisioning. |

Set on a PV:

```yaml
spec:
  persistentVolumeReclaimPolicy: Retain   # or Delete
```

Set as the default for a StorageClass:

```yaml
reclaimPolicy: Delete   # default for dynamic provisioning; can be Retain
```

> **💡 Exam Tip:** With **Delete**, deleting the PVC also deletes the PV (and the real disk). With **Retain**, deleting the PVC leaves the PV in **Released** state and preserves the data — requiring manual intervention to reuse. Use **Retain** for databases/important data; use **Delete** for scratch data. Remember the defaults: static PVs default to Retain; dynamically provisioned PVs default to Delete.

*Source: Storage for CKA — Volume Reclaim Policies*

---

## StorageClasses and Dynamic Provisioning

Manually creating a PV for every developer request does not scale. A **StorageClass** is a cluster-level resource that defines classes/tiers of storage (e.g., fast SSD vs. slow HDD) and acts as a **template/factory** for creating PVs on demand.

### How dynamic provisioning works

1. A user creates a PVC that references a StorageClass by name.
2. Kubernetes sees the PVC, looks up the StorageClass, and invokes the StorageClass's **provisioner**.
3. The provisioner creates a brand-new PV matching the request.
4. The new PV is automatically bound to the PVC.

### Key StorageClass fields

- **provisioner** — the most important field; tells Kubernetes which volume plugin/driver to use (e.g., `kubernetes.io/minikube-hostpath`, `ebs.csi.aws.com`, `csi.vsphere.vmware.com`, an NFS provisioner).
- **parameters** — passed to the provisioner (e.g., disk `type: pd-standard`, replication).
- **reclaimPolicy** — `Delete` (default) or `Retain`.
- **allowVolumeExpansion** — when `true`, users can grow an existing PVC and the provisioner expands the PV.
- **volumeBindingMode** — `Immediate` or `WaitForFirstConsumer` (see below).

### Example StorageClass

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: fast-storage
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
reclaimPolicy: Delete
allowVolumeExpansion: true
volumeBindingMode: WaitForFirstConsumer
```

### PVC referencing a StorageClass

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: demo-pvc
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 1Gi
  storageClassName: fast-storage
```

### Default StorageClass

If a PVC specifies **no** `storageClassName`, the cluster's **default** StorageClass is used (shown as `(default)` in `kubectl get sc`). To force static provisioning instead, set `storageClassName: ""`.

### Commands

```bash
kubectl get sc                              # sc = storageclass short name
kubectl get storageclass
kubectl describe sc standard                # shows Provisioner, ReclaimPolicy, VolumeBindingMode
kubectl delete sc <name>
```

> **💡 Exam Tip:** The `provisioner` is the field that makes a StorageClass work. To use the cluster default for a dynamic PVC, simply omit `storageClassName`; to force static binding, set it to `""`. Know that dynamically provisioned PVs default to a `Delete` reclaim policy, so deleting the PVC also removes the PV.

*Source: Storage for CKA — Storage Classes in Kubernetes*

---

## volumeBindingMode: Immediate vs WaitForFirstConsumer

`volumeBindingMode` controls **when** a PV is provisioned and bound:

- **Immediate** — the PV is created/bound as soon as the PVC is created, even before any pod uses it. The storage is reserved immediately.
- **WaitForFirstConsumer** — provisioning/binding is **delayed until a pod that uses the PVC is scheduled**. Until then the PVC stays **Pending** and no PV exists.

Why WaitForFirstConsumer matters:
- Avoids unused volumes (more efficient resource use).
- The volume is created on the **node where the pod is scheduled**, leading to better, topology-aware scheduling decisions (critical for zonal/node-local storage).

Observed behavior with WaitForFirstConsumer:
- After creating the PVC: `kubectl get pvc` shows **Pending**, and `kubectl get pv` returns no resources.
- After creating a pod that mounts the PVC: the pod runs, the PVC becomes **Bound**, and a new PV appears.

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: delayed-binding-sc
provisioner: k8s.io/minikube-hostpath
volumeBindingMode: WaitForFirstConsumer
# reclaimPolicy omitted -> defaults to Delete
```

> **💡 Exam Tip:** If a PVC is stuck in **Pending** and `kubectl get pv` shows nothing, check the StorageClass — `WaitForFirstConsumer` will not provision a PV until a consuming pod is scheduled. Create the pod to trigger binding. With `Immediate`, the PV is created right away regardless of any pod.

*Source: Storage for CKA — Storage Classes / WaitForFirstConsumer Binding*

---

## CSI (Container Storage Interface) Basics

The **Container Storage Interface (CSI)** is the standard plugin model that lets storage vendors expose their systems to Kubernetes without modifying core Kubernetes code. In production clusters you reference a CSI driver as the StorageClass `provisioner`:

- `ebs.csi.aws.com` — AWS EBS
- `csi.vsphere.vmware.com` — VMware vSphere
- `csi-hostpath` — a CSI hostpath driver used in test clusters

Some demo/test setups use a no-provisioning option (e.g., `kubernetes.io/no-provisioner`) where volumes are statically created rather than dynamically provisioned.

> **💡 Exam Tip:** On the exam you generally consume an existing CSI-backed StorageClass rather than installing a driver. Find available classes with `kubectl get sc`, then reference one by name in your PVC's `storageClassName`. The provisioner string identifies the CSI driver.

*Source: Kubernetes docs — Container Storage Interface*

---

## Exam Workflow and Productivity Tips

- Set an alias: `alias k=kubectl`, then use `k get pod -A`.
- Export dry-run/output flags: `export do="--dry-run=client -o yaml"`, then `k run pod1 --image=nginx $do > pod.yaml`, edit, and `k apply -f pod.yaml`. This generates boilerplate fast and avoids typos.
- Learn short names: `sc` (storageclass), `pv`, `pvc`, `rs` (replicaset). List them with `kubectl api-resources`.
- Always switch context first: `kubectl config use-context <name>` (then `kubectl config current-context` to confirm). Wrong context = resources in the wrong namespace.
- Use the docs page "Configure a Pod to Use a PersistentVolume for Storage" as a copy/paste base for PV, PVC, and pod manifests.
- Manage time: flag and skip hard tasks; you only need 66% to pass.

### Static provisioning task pattern (worked example)

Create a PV `task-pv` (200Mi, RWO, Retain, hostPath `/opt/data`) and a PVC `task-pvc` that binds to it:

```yaml
apiVersion: v1
kind: PersistentVolume
metadata:
  name: task-pv
spec:
  capacity:
    storage: 200Mi
  accessModes:
    - ReadWriteOnce
  persistentVolumeReclaimPolicy: Retain
  storageClassName: ""
  hostPath:
    path: /opt/data
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: task-pvc
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: ""
  resources:
    requests:
      storage: 200Mi
```

### Dynamic provisioning task pattern (worked example)

Create a PVC using the default StorageClass and mount it in a pod:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: dynamic-pvc
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 50Mi
  # no storageClassName -> uses the default StorageClass
---
apiVersion: v1
kind: Pod
metadata:
  name: data-pod
spec:
  containers:
    - name: test-container
      image: busybox:latest
      command: ["/bin/sh"]
      args: ["-c", "sleep 300"]
      volumeMounts:
        - name: test
          mountPath: /data
  volumes:
    - name: test
      persistentVolumeClaim:
        claimName: dynamic-pvc
```

> **💡 Exam Tip:** A `busybox` container with no command will start, do nothing, and crash (CrashLoopBackOff). Give it a long-running command like `sleep 300` (or `["/bin/sh", "-c", "sleep 3600"]`) so the pod stays Running long enough to verify the mount.

*Source: Storage for CKA — Exam Tips / Example Exam Questions*
