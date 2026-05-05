import { requestUrl } from "obsidian";
import { FileStation } from "../src/filestation";

const mockedRequestUrl = requestUrl as jest.Mock;

describe("FileStation", () => {
  beforeEach(() => {
    mockedRequestUrl.mockReset();
  });

  it("uses POST auth flow for QuickConnect relay endpoints", async () => {
    mockedRequestUrl
      .mockRejectedValueOnce(new Error("invalid json '<'"))
      .mockResolvedValueOnce({
        status: 200,
        json: {
          success: true,
          data: {
            sid: "sid-123",
            device_id: "device-token-123",
          },
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        json: { success: true, data: { model: "DS", version_string: "DSM 7" } },
      });

    const fs = new FileStation({
      baseUrl: "https://example-nas.us5.quickconnect.to:443",
      username: "user",
      password: "pass",
      otpCode: "123456",
      quickConnectRelay: true,
    });

    await expect(fs.login()).resolves.toEqual({
      sid: "sid-123",
      deviceId: "",
      deviceToken: "device-token-123",
    });

    expect(mockedRequestUrl).toHaveBeenNthCalledWith(1, {
      url: "https://example-nas.us5.quickconnect.to:443/",
      method: "GET",
      throw: false,
    });
    expect(mockedRequestUrl).toHaveBeenNthCalledWith(2, {
      url: "https://example-nas.us5.quickconnect.to:443/webapi/entry.cgi",
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body: expect.stringContaining("api=SYNO.API.Auth"),
    });
    expect(mockedRequestUrl).toHaveBeenNthCalledWith(2, expect.objectContaining({
      body: expect.stringContaining("client=browser"),
    }));
  });

  it("fails clearly when relay auth times out", async () => {
    jest.useFakeTimers();
    mockedRequestUrl
      .mockRejectedValueOnce(new Error("invalid json '<'"))
      .mockReturnValueOnce(new Promise(() => undefined));

    const fs = new FileStation({
      baseUrl: "https://example-nas.us5.quickconnect.to:443",
      username: "user",
      password: "pass",
      quickConnectRelay: true,
    });

    const login = fs.login();
    const expectation = expect(login).rejects.toThrow("relay entry.cgi login request timed out");
    await jest.runAllTimersAsync();

    await expectation;
    jest.useRealTimers();
  });

  describe("listAllFiles", () => {
    function makeListResp(files: Array<{ path: string; name: string; isdir: boolean }>) {
      return {
        status: 200,
        json: { success: true, data: { files } },
      };
    }

    function makeFs(): FileStation {
      const fs = new FileStation({
        baseUrl: "https://nas.local:5001",
        username: "u",
        password: "p",
      });
      // Skip login: stub a fake sid so url() doesn't blow up.
      // (sid is private; reach in for the test.)
      (fs as unknown as { sid: string }).sid = "test-sid";
      return fs;
    }

    function decodedFolderPath(url: string): string | null {
      const m = url.match(/folder_path=([^&]+)/);
      return m ? decodeURIComponent(m[1]) : null;
    }

    it("returns successful entries while skipping a folder whose listFolder rejects", async () => {
      const fs = makeFs();

      // Tree: /root → /root/ok (1 file), /root/bad (rejects)
      mockedRequestUrl.mockImplementation((opts: { url: string }) => {
        const fp = decodedFolderPath(opts.url);
        if (fp === "/root") {
          return Promise.resolve(makeListResp([
            { path: "/root/ok", name: "ok", isdir: true },
            { path: "/root/bad", name: "bad", isdir: true },
          ]));
        }
        if (fp === "/root/ok") {
          return Promise.resolve(makeListResp([
            { path: "/root/ok/note.md", name: "note.md", isdir: false },
          ]));
        }
        if (fp === "/root/bad") {
          return Promise.reject(new Error("permission denied"));
        }
        return Promise.reject(new Error(`unexpected url: ${opts.url}`));
      });

      const all = await fs.listAllFiles("/root");
      expect(all).toHaveLength(1);
      expect(all[0].path).toBe("/root/ok/note.md");
    });

    it("processes folders in parallel batches (does not abort on a single failure)", async () => {
      const fs = makeFs();

      mockedRequestUrl.mockImplementation((opts: { url: string }) => {
        const fp = decodedFolderPath(opts.url);
        if (fp === "/root") {
          // 7 child folders to force more than one BATCH=5 slice.
          const children = Array.from({ length: 7 }, (_, i) => ({
            path: `/root/c${i}`,
            name: `c${i}`,
            isdir: true,
          }));
          return Promise.resolve(makeListResp(children));
        }
        const m = fp ? fp.match(/^\/root\/c(\d+)$/) : null;
        if (m) {
          const i = parseInt(m[1], 10);
          if (i === 3) return Promise.reject(new Error("transient")); // one bad
          return Promise.resolve(makeListResp([
            { path: `/root/c${i}/n.md`, name: "n.md", isdir: false },
          ]));
        }
        return Promise.reject(new Error(`unexpected url: ${opts.url}`));
      });

      const all = await fs.listAllFiles("/root");
      // 6 files (one folder failed)
      expect(all).toHaveLength(6);
      expect(all.map((f) => f.path).sort()).toEqual([
        "/root/c0/n.md",
        "/root/c1/n.md",
        "/root/c2/n.md",
        "/root/c4/n.md",
        "/root/c5/n.md",
        "/root/c6/n.md",
      ]);
    });
  });
});
