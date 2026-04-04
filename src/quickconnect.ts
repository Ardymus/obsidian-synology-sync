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

  // Build candidate list ordered by preference
  const candidates: Array<{ host: string; port: number; https: boolean }> = [];

  for (const info of results) {
    if (info.errno) continue;
    const svc = info.service;
    const srv = info.server;

    // LAN IPs (prefer HTTPS)
    if (srv.interface) {
      for (const iface of srv.interface) {
        if (iface.ip) {
          if (svc.port) candidates.push({ host: iface.ip, port: svc.port, https: true });
          if (svc.port) candidates.push({ host: iface.ip, port: svc.port, https: false });
        }
      }
    }

    // FQDN / DDNS
    if (srv.fqdn && svc.ext_port) {
      candidates.push({ host: srv.fqdn, port: svc.ext_port, https: true });
    }
    if (srv.ddns && svc.ext_port) {
      candidates.push({ host: srv.ddns, port: svc.ext_port, https: true });
    }

    // External IP
    if (srv.external?.ip && svc.ext_port) {
      candidates.push({ host: srv.external.ip, port: svc.ext_port, https: true });
      candidates.push({ host: srv.external.ip, port: svc.ext_port, https: false });
    }
  }

  if (candidates.length === 0) {
    throw new Error(`QuickConnect could not resolve "${quickConnectId}"`);
  }

  // Ping-pong test each candidate
  for (const c of candidates) {
    const proto = c.https ? "https" : "http";
    const url = `${proto}://${c.host}:${c.port}/webman/pingpong.cgi?action=cors&quickconnect=true`;
    try {
      const r = await requestUrl({ url, method: "GET", throw: false });
      if (r.status === 200) {
        const data = r.json;
        if (data?.success) {
          return c;
        }
      }
    } catch {
      // candidate unreachable, try next
    }
  }

  // If ping-pong fails on all, return first candidate as best guess
  return candidates[0];
}
