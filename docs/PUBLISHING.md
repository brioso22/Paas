# Publicación de proyectos fuera de la red local

> Estado: **solo la estructura está implementada.** El único proveedor funcional es
> `none`. Los proveedores `tailscale-funnel` y `cloudflare-tunnel` existen como stubs
> que lanzan `NotImplementedError`, y `src/config.js` rechaza seleccionarlos para que
> nadie crea que están activos.

## Cómo encaja en el panel

```
despliegue OK ──► publisher.expose(project) ──► { exposed, url, message } ──► log del despliegue
borrar proyecto ─► publisher.unexpose(project)
página Resumen ──► publisher.status(project)  ──► fila "Publicación"
```

- Interfaz: `src/services/publisher/provider.js` (`PublishProvider`).
- Registro de proveedores: `src/services/publisher/index.js` (`PROVIDERS`).
- Selección: variable `PUBLISH_PROVIDER` (por defecto `none`).
- Un fallo de `expose()` se registra como aviso; **no** marca el despliegue como fallido
  (la app ya está corriendo en el clúster).

### Contrato

| Método | Debe ser | Devuelve |
|---|---|---|
| `expose(project)` | idempotente | `{ exposed, url, message }` |
| `unexpose(project)` | idempotente, no falla si ya no existía | `{ exposed: false, … }` |
| `status(project)` | barato (se llama al abrir la página) | `{ exposed, url, message }` |

`project` es la fila de la tabla `projects` (`name`, `namespace`, `port`, …). El host
interno siempre es `<name>.<DOMAIN>` y el ingress se alcanza en
`INGRESS_IP:INGRESS_NODEPORT`.

### Pasos para implementar un proveedor

1. Completar la clase en `src/services/publisher/<proveedor>.js`.
2. Si necesita un binario (`tailscale`, `cloudflared`), añadirlo a `ALLOWED_COMMANDS`
   en `src/lib/exec.js` y ejecutarlo **solo** a través de `ctx.exec.run` (con
   argumentos en arreglo y `secrets` para redactar tokens).
3. Añadir su nombre a `IMPLEMENTED_PROVIDERS` en `src/config.js`.
4. Agregar tests con `DRY_RUN` que comprueben la secuencia exacta de comandos, igual que
   `test/deploy-flow.test.js`.

---

## Opción A: Cloudflare Tunnel con wildcard `*.dominio` (recomendada para público)

Requisitos: un dominio gestionado en Cloudflare (p. ej. `apps.ejemplo.com`).

1. En el servidor, instalar `cloudflared` y autenticar: `cloudflared tunnel login`.
2. Crear el túnel: `cloudflared tunnel create paas`.
3. DNS wildcard: `cloudflared tunnel route dns paas '*.apps.ejemplo.com'`.
4. `~/.cloudflared/config.yml`:

   ```yaml
   tunnel: <TUNNEL_ID>
   credentials-file: /home/<usuario>/.cloudflared/<TUNNEL_ID>.json
   ingress:
     - hostname: "*.apps.ejemplo.com"
       service: http://192.168.49.2:32134   # INGRESS_IP:INGRESS_NODEPORT
       originRequest:
         httpHostHeader: ""                 # conserva el Host original
     - service: http_status:404
   ```

5. Correrlo como servicio de usuario (`cloudflared tunnel run paas`).
6. En el panel: `DOMAIN=apps.ejemplo.com` (los hosts del ingress pasan a ser
   `<proyecto>.apps.ejemplo.com`).

Con el wildcard, `expose()` **no necesita llamar a Cloudflare**: basta con comprobar que
`https://<proyecto>.apps.ejemplo.com` responde. Solo si se quisiera un host por proyecto
sin wildcard habría que crear registros DNS con la API (token con permiso `DNS:Edit`,
guardado en `.env`, nunca en el repo).

TLS lo termina Cloudflare. Para cifrar también el tramo túnel → ingress, ver la opción C.

Nota: el panel en sí **no** debería publicarse por el mismo túnel sin antes añadir
Cloudflare Access (o equivalente) delante.

## Opción B: Tailscale Funnel

Funnel publica en Internet puertos del propio nodo bajo `https://<host>.<tailnet>.ts.net`.

Limitaciones que condicionan el diseño:

- Un único nombre por nodo: **no hay subdominios por proyecto**. Cada proyecto se
  publicaría como ruta: `https://<host>.<tailnet>.ts.net/<proyecto>/`.
- Solo los puertos 443, 8443 y 10000.
- La app debe tolerar el prefijo de ruta, o el ingress debe reescribirlo
  (`nginx.ingress.kubernetes.io/rewrite-target`), lo que exige que el chart acepte
  `ingress.annotations`.

Implementación prevista:

- `expose()`: `tailscale funnel --bg --set-path=/<proyecto> http://<INGRESS_IP>:<NODEPORT>`
  y añadir el host `<host>.<tailnet>.ts.net` a `ingress.hosts` del proyecto.
- `unexpose()`: `tailscale funnel --set-path=/<proyecto> off`.
- `status()`: interpretar `tailscale funnel status --json`.
- Una vez: `sudo tailscale set --operator=$USER` para no requerir sudo desde el panel.

Para acceso **privado** (solo tus dispositivos) no hace falta Funnel: basta con
Tailscale y un DNS que resuelva `*.paas.local` a la IP del servidor en la tailnet, más
un proxy en el host hacia `INGRESS_IP:INGRESS_NODEPORT`.

## Opción C: HTTPS dentro del clúster con cert-manager (autofirmado)

Sirve para la red local / Tailscale, o para cifrar el tramo túnel → ingress.

1. Instalar cert-manager:

   ```bash
   helm repo add jetstack https://charts.jetstack.io
   helm install cert-manager jetstack/cert-manager -n cert-manager --create-namespace --set crds.enabled=true
   ```

2. Crear una CA propia:

   ```yaml
   apiVersion: cert-manager.io/v1
   kind: ClusterIssuer
   metadata: { name: selfsigned }
   spec: { selfSigned: {} }
   ---
   apiVersion: cert-manager.io/v1
   kind: Certificate
   metadata: { name: paas-ca, namespace: cert-manager }
   spec:
     isCA: true
     commonName: paas-ca
     secretName: paas-ca
     issuerRef: { name: selfsigned, kind: ClusterIssuer }
   ---
   apiVersion: cert-manager.io/v1
   kind: ClusterIssuer
   metadata: { name: paas-ca }
   spec: { ca: { secretName: paas-ca } }
   ```

3. Por proyecto (lo haría `expose()` con `kubectl apply -f -`), un `Certificate` en su
   namespace:

   ```yaml
   apiVersion: cert-manager.io/v1
   kind: Certificate
   metadata: { name: <proyecto>-tls, namespace: tenant-<proyecto> }
   spec:
     secretName: <proyecto>-tls
     dnsNames: [ "<proyecto>.<DOMAIN>" ]
     issuerRef: { name: paas-ca, kind: ClusterIssuer }
   ```

4. En `buildValues()` (`src/services/helm.js`), rellenar
   `ingress.tls: [{ secretName: "<proyecto>-tls", hosts: ["<proyecto>.<DOMAIN>"] }]`.
   Usar un `Certificate` explícito evita depender de que el chart acepte
   `ingress.annotations`.
5. Importar el certificado de `paas-ca` en los navegadores de confianza
   (`kubectl get secret paas-ca -n cert-manager -o jsonpath='{.data.ca\.crt}' | base64 -d`).

La ResourceQuota de cada tenant no limita Secrets, así que el `Certificate` cabe sin
cambios. La NetworkPolicy no afecta: cert-manager no necesita entrar al namespace con un
emisor CA (no hay desafío HTTP-01).
