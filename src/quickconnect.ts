import { requestUrl } from "obsidian";

interface QCServerInfo {
  command: string;
  env: {
    relay_region: string;
    control_host: string;
  };
  server: {
    serverID: string;
    interface: Array<{ ip: string; ipv6?: Array<{ address: string }> }>;
    external: { ip: string; ipv6?: string };
    fqdn?: string;
    ddns?: string;
  };
  service: {
    port: number;
    ext_port: number;
    relay_ip?: string;
    relay_port?: number;
    https_ip?: string;
    https_port?: number;
  };
  smartdns?: {
    host: string;
    external?: string;
    lan?: string[];
    lanv6?: string[];
  };
  errno?: number;
}

interface ResolvedNAS {
  host: string;
  port: number;
  https: boolean;
}

export async function resolveQuickConnect(quickConnectId: string): Promise<ResolvedNAS> {
  const body = JSON.stringify([
    {
      version: 1,
      command: "get_server_info",
      stop_when_error: false,
      stop_when_success: false,
      id: "dsm_portal_https",
      serverID: quickConnectId,
      is_gofile: false,
    },
    {
      version: 1,
      command: "get_server_info",
      stop_when_error: false,
      stop_when_success: false,
      id: "dsm_portal",
      serverID: quickConnectId,
      is_gofile: false,
    },
  ]);

  const resp = await requestUrl({
    url: "https://global.quickconnect.to/Serv.php",
    method: "POST",
    body,
    headers: { "Content-Type": "application/json" },
  });

  const results: QCServerInfo[] = resp.json;
  if (!results || results.length === 0) {
    throw new Error("QuickConnect returned empty response");
  }

  // Build candidate list ordered by preference.
  // SmartDNS hostnames have valid wildcard certs under *.direct.quickconnect.to,
  // so HTTPS works without self-signed cert errors (even for LAN IPs).
  const candidates: ResolvedNAS[] = [];

  for (const info of results) {
    if (info.errno) continue;
    const svc = info.service;
    const srv = info.server;
    const dns = info.smartdns;

    // 1. SmartDNS LAN hostnames (best: valid cert + LAN speed)
    //    e.g. 192-168-1-201.MY-NAS.direct.quickconnect.to
    if (dns?.lan) {
      for (const lanHost of dns.lan) {
        candidates.push({ host: lanHost, port: svc.port, https: true });
      }
    }

    // 2. SmartDNS external hostname (valid cert + WAN)
    if (dns?.external) {
      const port = svc.ext_port || svc.port;
      candidates.push({ host: dns.external, port, https: true });
    }

    // 3. SmartDNS base host (fallback)
    if (dns?.host) {
      candidates.push({ host: dns.host, port: svc.port, https: true });
    }

    // 4. HTTPS relay (tunnel through Synology's relay servers)
    if (svc.https_ip && svc.https_port) {
      candidates.push({ host: svc.https_ip, port: svc.https_port, https: true });
    }

    // 5. FQDN / DDNS
    if (srv.fqdn && srv.fqdn !== "NULL") {
      const port = svc.ext_port || svc.port;
      candidates.push({ host: srv.fqdn, port, https: true });
    }
    if (srv.ddns && srv.ddns !== "NULL") {
      const port = svc.ext_port || svc.port;
      candidates.push({ host: srv.ddns, port, https: true });
    }

    // 6. Raw LAN IPs over HTTP (no cert needed, but unencrypted)
    if (srv.interface) {
      for (const iface of srv.interface) {
        if (iface.ip) {
          candidates.push({ host: iface.ip, port: svc.port, https: false });
        }
      }
    }

    // 7. Raw external IP (last resort)
    if (srv.external?.ip && srv.external.ip !== "0.0.0.0") {
      const port = svc.ext_port || svc.port;
      if (port) {
        candidates.push({ host: srv.external.ip, port, https: false });
      }
    }
  }

  if (candidates.length === 0) {
    throw new Error(`QuickConnect could not resolve "${quickConnectId}"`);
  }

  // Ping-pong test each candidate (timeout 3s per candidate)
  for (const c of candidates) {
    const proto = c.https ? "https" : "http";
    const url = `${proto}://${c.host}:${c.port}/webman/pingpong.cgi?action=cors&quickconnect=true`;
    try {
      const r = await requestUrl({ url, method: "GET", throw: false });
      if (r.status === 200 && r.json?.success) {
        return c;
      }
    } catch {
      // candidate unreachable, try next
    }
  }

  // If ping-pong fails on all, return first candidate as best guess
  return candidates[0];
}
