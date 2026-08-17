# Services and Networking — CKA Study Guide

This guide covers the CKA **Services and Networking** domain (20% of the exam). It is grounded in the Pluralsight course *Configuring and Managing Kubernetes Networking, Services, and Ingress* and supplemented with official Kubernetes documentation (~v1.34/1.35) for exam-required subtopics that the course does not cover in depth (Gateway API, NetworkPolicy, EndpointSlices).

---

## 1. The Kubernetes Networking Model

Kubernetes defines a networking model that every network implementation must satisfy. The model imposes a small set of rules so that developers get simple, consistent networking and administrators can choose how to implement it.

### The rules of the model
- **All Pods can communicate with all other Pods on all nodes** — anywhere in the cluster, regardless of the underlying topology.
- **Agents on a node (kubelet, kube-proxy, system daemons) can communicate with all Pods on that node.**
- **No NAT (Network Address Translation)** — every Pod reaches every other Pod using the Pod's **real IP address**. A Pod sees its own IP as the same address other Pods use to reach it.

### Why the model exists
It gives developers a simpler, consistent abstraction (hiding implementation details), lets them define and consume networking in deployment manifests, and lets clusters span subnets, cloud fault domains, or availability zones. This makes service discovery simpler — Pods and Services find each other via real IPs registered in DNS or environment variables.

### The three networks in a cluster
- **Node network** — the real data-center or cloud (virtual) network. Each node gets an IP here.
- **Pod network** — each Pod gets a single IP. IPs usually come from a dedicated **Pod CIDR range** (e.g. `192.168.0.0/16` with Calico in the course lab).
- **Cluster network** — used by **ClusterIP** services. IPs come from the range set by `--service-cluster-ip-range` on the API server and controller manager.

> **💡 Exam Tip:** Memorize the three rules: all Pods talk to all Pods, node agents talk to local Pods, and **no NAT** (real Pod IPs). If a question describes Pods needing source NAT to reach each other, that violates the Kubernetes networking model.

*Source: Configuring and Managing Kubernetes Networking, Services, and Ingress — Kubernetes Network Model and Cluster Network Topology*

---

## 2. Pod-to-Pod Connectivity Internals

### Inside a Pod
- Containers in a multi-container Pod **share one network namespace** — a single IP and port range — and communicate over **localhost**.
- The network namespace is created by a special **pause (infrastructure) container** that starts first and sets up the namespace. Because the pause container owns the namespace, application containers can restart without losing the Pod's network stack. The pause container shares the Pod's lifecycle.

### Pod-to-Pod on the same node
Pods use an interface inside the Pod (e.g. `eth0`) attached to a local software **bridge** or **tunnel** interface; they talk on their real Pod IPs.

### Pod-to-Pod across nodes
Pods communicate on their real IPs. The network between nodes must support this via **Layer 2**, **Layer 3 routing**, or an **overlay network**. An overlay gives the appearance of a single network and uses tunnels (encapsulation) to move Pod packets between nodes — independence from the underlying infrastructure. The course lab's Calico uses IP-in-IP tunnels with routes pointing traffic for each node's Pod range into the `tunl0` interface.

> **💡 Exam Tip:** A multi-container Pod shares one IP — containers reach each other on `localhost` (different ports), never on a separate IP. The **pause container** holds the network namespace so app containers can restart without re-IPing the Pod.

*Source: Configuring and Managing Kubernetes Networking, Services, and Ingress — Pod Networking Communication Patterns and Internals*

---

## 3. The Container Network Interface (CNI)

Kubernetes defines the network model but **abstracts the implementation** out via the **CNI**. The CNI is a standard spec for managing container networking, used across orchestrators. Kubernetes calls the CNI, which works with the container runtime and base OS to set up namespaces, interfaces, bridges/tunnels, and IP addressing — adding/removing resources as Pods come and go.

- CNI plugins (Calico, Cilium, Flannel, Weave, etc.) **implement** the networking model and provide different capabilities: network policy, encryption, traffic segmentation, QoS.
- Plugins are commonly deployed as **Pods controlled by a DaemonSet** (one per node).
- The **kubelet** configures the node's network plugin — either **CNI** (loads the plugin + config) or the legacy **kubenet** (uses routes and bridges, e.g. `cbr0`, in the base OS rather than tunnels). With kubenet, each node's `PodCIDR` is the range Pods on that node draw from.

> **💡 Exam Tip:** Kubernetes does not implement Pod networking itself — a **CNI plugin** does. NetworkPolicy enforcement also requires a CNI that supports it (e.g. Calico, Cilium). If no supporting CNI is installed, NetworkPolicy objects exist but are silently not enforced.

*Source: Configuring and Managing Kubernetes Networking, Services, and Ingress — Container Network Interface (CNI)*

---

## 4. Services

### Why Services exist
Pods are ephemeral — their count and IPs change during scaling or controller operations. A **Service** provides a persistent **virtual IP** and **DNS name** as a stable front end and load balances incoming traffic across the backing Pods, which is updated automatically as Pods come and go.

### Selectors, endpoints, and EndpointSlices
- A Service uses **labels and selectors** to choose member Pods. A controller watches which Pods match the selector; for each match an **endpoint** (Pod IP + target port) is created and added to the load-balancing list.
- Remove a Pod's matching label and it is dropped from the Service (it still runs — it's just no longer load balanced to).
- Modern Kubernetes tracks endpoints in **EndpointSlices** (`kubectl get endpointslices`), which scale better than the legacy single `Endpoints` object by splitting endpoints into smaller chunks. *(Kubernetes docs)*

### kube-proxy
**kube-proxy** implements Services on the network and runs as a Pod via a **DaemonSet** (one per node). It watches the API server for Services and endpoints and programs the local dataplane to match. Default/most-common mode is **iptables**; alternatives are **IPVS** and the legacy **userspace** proxy. A ClusterIP is purely virtual — it exists only in iptables rules on each node.

### port vs targetPort vs nodePort
- **`port`** — the port the **Service** listens on (clients connect here).
- **`targetPort`** — the port the **container/application** listens on inside the Pod.
- **`nodePort`** — the port opened on **every node's IP** (NodePort/LoadBalancer only). Default range **30000–32767**; can be auto-assigned or set statically.

### Service types

#### ClusterIP (default)
Exposes the Service on a **cluster-internal IP**, reachable only inside the cluster. The default type if none is specified. Foundation for the other types. Use for internal-only services or services fronted by Ingress.

```yaml
apiVersion: v1
kind: Service
metadata:
  name: hello-world
spec:
  type: ClusterIP
  selector:
    run: hello-world
  ports:
    - protocol: TCP
      port: 80
      targetPort: 8080
```

#### NodePort
Exposes the Service on each node's real IP at a `nodePort` (30000–32767). Creating a NodePort **also creates a ClusterIP**. External traffic to `<any-node-IP>:<nodePort>` is routed by kube-proxy to the ClusterIP, then to a Pod endpoint (possibly on another node, across the Pod network). Used for external load balancer integration and dev/desktop clusters.

#### LoadBalancer
Asks the **cloud provider** to provision a cloud load balancer with a real public IP. Creating a LoadBalancer **also creates a NodePort and a ClusterIP**. The cloud LB sends traffic to the NodePort on nodes → ClusterIP → Pods. `EXTERNAL-IP` shows `<pending>` until the cloud provisions it.

#### ExternalName
Provides service discovery for a service **outside** the cluster. Kubernetes creates a **CNAME** record pointing to an external DNS name. No selector, no proxying.

```yaml
apiVersion: v1
kind: Service
metadata:
  name: hello-world-api
spec:
  type: ExternalName
  externalName: hello-world.api.example.com
```

#### Headless service
A Service with **`clusterIP: None`**. With selectors, DNS returns **all matching Pod IPs** (A/AAAA records) rather than a single virtual IP — the client picks one. Common with databases and **StatefulSets**.

#### Services without selectors
No selector means you **manually create the EndpointSlice/Endpoints** objects with whatever IP/port you want (inside or outside the cluster). Multiple endpoints are load balanced. Used to manually control traffic targets while keeping service discovery.

### Imperative commands
```bash
kubectl create deployment hello-world --image=<image>
kubectl scale deployment hello-world --replicas=6
kubectl expose deployment hello-world --port=80 --target-port=8080 --type=NodePort
kubectl get service
kubectl get endpoints hello-world          # or: kubectl get endpointslices
kubectl describe service hello-world
kubectl get pods --show-labels
```

> **💡 Exam Tip:** Each higher service type builds on the lower ones: **LoadBalancer → NodePort → ClusterIP**. Know `port` (Service) vs `targetPort` (container) vs `nodePort` (node, 30000–32767). If `EXTERNAL-IP` stays `<pending>`, the cluster has no cloud LoadBalancer integration (e.g. bare metal). If `kubectl get endpoints` is empty, the Service selector doesn't match any running/ready Pod's labels.

*Source: Configuring and Managing Kubernetes Networking, Services, and Ingress — Understanding Services; Service Types; Service Networking Internals*

---

## 5. DNS and CoreDNS

### The cluster DNS service
Kubernetes provides DNS as a cluster service using **CoreDNS**. By default a Deployment runs **2 CoreDNS Pods** in `kube-system` for load balancing and resilience, fronted by a ClusterIP Service named **`kube-dns`** (default `10.96.0.10`), listening on port 53 (UDP/TCP) plus 9153 (metrics). Pods are configured to use it by default.

### DNS records created
- **Services** get **A** (IPv4) / **AAAA** (IPv6) records.
- **Namespaces** get a DNS subdomain.

### Service FQDN pattern
```
<service>.<namespace>.svc.cluster.local
```
Example: `hello-world.default.svc.cluster.local`. The `svc` segment and `cluster.local` cluster domain are constant.

### Pod A-record pattern
A Pod's A record uses its dashed IP:
```
<pod-ip-with-dashes>.<namespace>.pod.cluster.local
```
Example: `192-168-206-124.default.pod.cluster.local`.

### CoreDNS configuration
- CoreDNS config lives in a **ConfigMap named `coredns`** in `kube-system`, mounted into the Pod at `/etc/coredns` as a file named **`Corefile`**.
- By default CoreDNS **forwards** unknown zones to the node's `/etc/resolv.conf`: `forward . /etc/resolv.conf`.
- To use a custom upstream, change the forward target (e.g. `forward . 1.1.1.1`) or add a server block for a **conditional forwarder** (e.g. forward `centinosystems.com` to `9.9.9.9`).
- Editing the ConfigMap updates the mounted file after a short delay; CoreDNS then reloads (visible in `kubectl logs`).

### Pod DNS client config: `dnsPolicy` and `dnsConfig`
- **`dnsPolicy`** options: `ClusterFirst` (**default** — cluster domain goes to cluster DNS, everything else to node DNS), `Default` (inherit the node's resolver — note this is *not* the default value), `ClusterFirstWithHostNet`, and `None`.
- **`None`** lets you fully define DNS in **`dnsConfig`** (custom `nameservers`, `searches`).

```yaml
spec:
  dnsPolicy: "None"
  dnsConfig:
    nameservers:
      - 9.9.9.9
    searches:
      - example.com
```

### Useful commands
```bash
kubectl get service kube-dns -n kube-system
kubectl get configmaps coredns -n kube-system -o yaml
kubectl describe deployment coredns -n kube-system
# query from inside a Pod:
nslookup hello-world.default.svc.cluster.local 10.96.0.10
kubectl exec -it <pod> -- cat /etc/resolv.conf
```

> **💡 Exam Tip:** Know the FQDN `service.namespace.svc.cluster.local` cold, and that CoreDNS config is the **`coredns` ConfigMap (`Corefile`) in `kube-system`**. Default `dnsPolicy` is **`ClusterFirst`** (the literal `Default` value means "inherit from node"). To set custom Pod nameservers you must set `dnsPolicy: None` plus a `dnsConfig`.

*Source: Configuring and Managing Kubernetes Networking, Services, and Ingress — Cluster DNS, Custom DNS Server and DNS Client Configurations; Cluster DNS Records for Pods and Services*

---

## 6. Service Discovery

Two built-in mechanisms, supporting infrastructure independence:
- **DNS** (preferred) — every Service gets a record; reference Services by name/FQDN. Updates without restarting Pods.
- **Environment variables** — for each Service that exists **at the time a Pod starts**, Kubernetes injects env vars (e.g. `HELLO_WORLD_CLUSTERIP_SERVICE_HOST`, `..._SERVICE_PORT`). A Service created **after** a Pod won't appear in that Pod's env until the Pod is recreated — a key reason to prefer DNS.

> **💡 Exam Tip:** Prefer DNS over env vars. Env vars are a snapshot at Pod startup and miss Services created afterward; DNS is dynamic.

*Source: Configuring and Managing Kubernetes Networking, Services, and Ingress — Service Discovery with DNS and Environment Variables*

---

## 7. Ingress

### Architecture: three pieces
- **Ingress resource** — the **rules** for how external HTTP(S) requests reach in-cluster services (hosts, paths, TLS). Rules only; no traffic by itself.
- **Ingress controller** — the **implementation** (an HTTP reverse proxy) that reads Ingress resources and actually routes traffic. Examples: NGINX Ingress (runs as Pods), hardware LBs (F5, Citrix), cloud controllers (Azure App Gateway, GCP LB). You must deploy one; clusters don't ship with one.
- **IngressClass** — associates an Ingress resource with a specific controller (`spec.ingressClassName`). A default class can be set via the `ingressclass.kubernetes.io/is-default-class: "true"` annotation.

The Ingress controller itself is exposed via a **NodePort** (bare metal) or **LoadBalancer** (cloud) Service. Requests hit that Service → controller Pod → routed **directly to Pod endpoints** (bypassing the ClusterIP for lower latency).

### Capabilities
- **Name-based virtual hosting** — route by HTTP **Host** header (many sites on one IP).
- **Path-based routing** — route by URL path.
- **TLS termination** — terminate HTTPS at the controller using a cert stored as a Secret.

### Why Ingress over a LoadBalancer service
Ingress works at **Layer 7** (HTTP), enabling path routing, name-based vhosts, URL rewriting, session persistence. One Ingress controller fronts **many** services on one IP (a LoadBalancer service exposes one service per IP/port at L4). Use Layer-4 LoadBalancer services for non-HTTP TCP/UDP.

### pathType values
- **`Prefix`** — partial prefix match (`/red` matches `/red`, `/red/1`).
- **`Exact`** — exact, case-sensitive match only.
- **`ImplementationSpecific`** — matching is up to the IngressClass/controller.

### defaultBackend
Handles requests that match no rule (otherwise clients get **404**). Always define one for path-based Ingress to gracefully handle unmatched paths.

### Example: path-based routing
```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ingress-path
spec:
  ingressClassName: nginx
  rules:
    - host: path.example.com
      http:
        paths:
          - path: /red
            pathType: Prefix
            backend:
              service:
                name: hello-world-service-red
                port:
                  number: 4242
          - path: /blue
            pathType: Exact
            backend:
              service:
                name: hello-world-service-blue
                port:
                  number: 4343
  defaultBackend:
    service:
      name: hello-world-service-single
      port:
        number: 80
```

### Example: name-based virtual hosts
```yaml
spec:
  ingressClassName: nginx
  rules:
    - host: red.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: hello-world-service-red
                port: { number: 4242 }
    - host: blue.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: hello-world-service-blue
                port: { number: 4343 }
```

### Example: TLS termination
First create the cert Secret, then reference it:
```bash
kubectl create secret tls tls-secret --key tls.key --cert tls.crt
```
```yaml
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - tls.example.com
      secretName: tls-secret
  rules:
    - host: tls.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: hello-world-service-single
                port: { number: 80 }
```
TLS terminates at the controller (port **443** by default). Controller-to-Pod traffic is unencrypted (port 80).

> **💡 Exam Tip:** **Ingress resource = rules; Ingress controller = implementation** — both are required, and a controller must be deployed first. `Prefix` does partial matching; `Exact` is exact and case-sensitive. Name-based vhosts also need DNS A records / the right `Host` header. For TLS, the Secret must be type `kubernetes.io/tls` (`tls.crt` + `tls.key`).

*Source: Configuring and Managing Kubernetes Networking, Services, and Ingress — Ingress Architecture; Path-Based Routing; Name-Based Virtual Hosts; TLS with Ingress*

---

## 8. Gateway API

The **Gateway API** is the newer, more expressive successor to Ingress for managing in-cluster traffic. It splits responsibilities across role-oriented resources *(Kubernetes docs)*:

- **GatewayClass** — cluster-scoped; defines a class of gateways backed by a controller (analogous to IngressClass / StorageClass). Managed by infrastructure providers.
- **Gateway** — an instance of traffic-handling infrastructure (e.g. a load balancer / listener). Defines listeners (protocol, port, hostnames, TLS). Managed by cluster operators.
- **HTTPRoute** (and TCPRoute, GRPCRoute, etc.) — defines protocol-specific routing rules (hostnames, path/header matches, backends) and **attaches** to a Gateway. Managed by application developers.

### How it differs from Ingress
- **Role separation**: GatewayClass (provider) / Gateway (operator) / Route (developer) vs. Ingress packing everything into one resource.
- **More protocols**: HTTP, HTTPS, TCP, UDP, gRPC — not just HTTP via annotations.
- **Portable, expressive matching** (headers, methods, query params, weights/traffic splitting) defined in the API spec rather than vendor annotations.
- **Cross-namespace routing** with explicit `ReferenceGrant` permissions.
- API group **`gateway.networking.k8s.io`**; it is a separate set of CRDs you install, not built into core Kubernetes.

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: example-gateway
spec:
  gatewayClassName: example-class
  listeners:
    - name: http
      protocol: HTTP
      port: 80
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: example-route
spec:
  parentRefs:
    - name: example-gateway
  hostnames:
    - "www.example.com"
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /app
      backendRefs:
        - name: app-service
          port: 80
```

> **💡 Exam Tip:** Map the roles: **GatewayClass (controller/provider) → Gateway (listeners/operator) → HTTPRoute (rules/developer)**. An HTTPRoute attaches to a Gateway via `parentRefs`; a Gateway references a GatewayClass via `gatewayClassName`. Gateway API is installed as CRDs under `gateway.networking.k8s.io`.

*Source: Configuring and Managing Kubernetes Networking, Services, and Ingress — Ingress Architecture (supplemented with Kubernetes docs)*

---

## 9. NetworkPolicy

A **NetworkPolicy** controls traffic to/from Pods at L3/L4. Key facts *(Kubernetes docs)*:

- **Requires a supporting CNI** (Calico, Cilium, Weave, etc.). Without one, policies are not enforced.
- **Default allow**: with no policy selecting a Pod, all ingress and egress is permitted.
- **Once a Pod is selected** by any policy for a direction (`policyTypes`), it becomes **default-deny for that direction**, and only explicitly allowed traffic is permitted.
- **Policies are additive** — multiple policies selecting a Pod are OR-combined (union of allowed traffic). There is no deny rule; you can't write an explicit block.
- Selectors: **`podSelector`** (Pods in the policy's namespace), **`namespaceSelector`** (whole namespaces), `ipBlock` (CIDR), and ports.
- An empty `podSelector: {}` selects **all Pods** in the namespace.

### Default deny-all ingress (and egress)
```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: default
spec:
  podSelector: {}
  policyTypes:
    - Ingress
    - Egress
```

### Allow ingress from a namespace + pod label on a port
```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-frontend
  namespace: backend
spec:
  podSelector:
    matchLabels:
      app: api
  policyTypes:
    - Ingress
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              team: web
          podSelector:
            matchLabels:
              app: frontend
      ports:
        - protocol: TCP
          port: 8080
```

Note: inside a single `from` element, combining `namespaceSelector` **and** `podSelector` (no `-` between them) means "Pods with this label **in** namespaces with this label" (AND). Listing them as separate array items means OR.

> **💡 Exam Tip:** NetworkPolicy is **default-allow until a Pod is selected**, then **default-deny for that direction**, and **additive** (union, no explicit deny). It **requires a CNI that supports it** — Flannel alone does not enforce policy. Watch the `from`/`to` YAML: namespaceSelector + podSelector in the *same* item = AND; as separate items = OR.

*Source: Configuring and Managing Kubernetes Networking, Services, and Ingress — CNI (supplemented with Kubernetes docs)*

---

## Quick Reference

| Concept | Key fact |
|---|---|
| Networking model | All Pods reach all Pods, no NAT, real Pod IPs |
| CNI | Implements the model; NetworkPolicy needs a supporting CNI |
| ClusterIP | Internal only; default type |
| NodePort | Node IP + 30000–32767; also makes a ClusterIP |
| LoadBalancer | Cloud LB + public IP; also makes NodePort + ClusterIP |
| ExternalName | CNAME to external DNS; no proxy |
| Headless | `clusterIP: None`; DNS returns Pod IPs |
| Service FQDN | `service.namespace.svc.cluster.local` |
| CoreDNS config | `coredns` ConfigMap (`Corefile`) in `kube-system` |
| kube-proxy | DaemonSet; iptables (default), IPVS, userspace |
| Ingress | resource = rules, controller = implementation, Layer 7 |
| pathType | Prefix / Exact / ImplementationSpecific |
| Gateway API | GatewayClass → Gateway → HTTPRoute |
| NetworkPolicy | additive, default-deny once selected, needs CNI |
