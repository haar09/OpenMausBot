import { join, sep } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createUpdateChecker, installKind, isNewerVersion, LATEST_RELEASE_URL, STABLE_CHANNEL_URL, RELEASE_HISTORY_URL, updateChannel } from "./update-check.ts";

const release = (tag: string) =>
  ({ ok: true, status: 200, json: async () => ({ tag_name: tag, html_url: `https://github.com/milind-soni/OpenMausBot/releases/tag/${tag}` }) }) as Response;

const promoted = (version: string) =>
  ({ ok: true, status: 200, json: async () => ({ channel: "stable", version, image: `ghcr.io/milind-soni/openmausbot@sha256:${"a".repeat(64)}`, releaseUrl: `https://github.com/milind-soni/OpenMausBot/releases/tag/v${version}` }) }) as Response;
const missing = { ok: false, status: 404, json: async () => ({}) } as Response;
/** GitHub's newest release is `newest`; the stable channel names `stable`, or does not exist yet. */
const github = (newest: string, stable: string | null) => vi.fn(async (url: string | URL | Request) =>
  String(url).startsWith(RELEASE_HISTORY_URL + "?") ? new Response(JSON.stringify([{ tag_name: newest }])) : String(url) === STABLE_CHANNEL_URL ? (stable ? promoted(stable) : missing) : release(newest));

describe("server update check", () => {
  it("tells how this server was installed", () => {
    const none = () => false;
    const root = ["", "srv", "OpenMausBot", "server"].join(sep);
    expect(installKind({ desktopManaged: true, managed: false, serverRoot: root, exists: () => true })).toBe("desktop");
    expect(installKind({ desktopManaged: false, managed: true, serverRoot: root, exists: () => true })).toBe("managed");
    expect(installKind({ desktopManaged: false, managed: false, serverRoot: root, exists: (path) => path === "/.dockerenv" })).toBe("docker");
    expect(installKind({ desktopManaged: false, managed: false, serverRoot: root, exists: (path) => path === "/run/.containerenv" })).toBe("podman");
    expect(installKind({
      desktopManaged: false, managed: false, exists: none,
      serverRoot: ["", "usr", "lib", "node_modules", "openmausbot", "dist-server"].join(sep),
    })).toBe("npm");
    expect(installKind({ desktopManaged: false, managed: false, serverRoot: root, exists: (path) => path === join(root, "..", ".git") })).toBe("git");
    expect(installKind({ desktopManaged: false, managed: false, serverRoot: root, exists: none })).toBe("unknown");
  });

  it("compares release versions numerically and never reports a malformed one", () => {
    expect(isNewerVersion("v0.1.93", "0.1.92")).toBe(true);
    expect(isNewerVersion("0.1.10", "0.1.9")).toBe(true);
    expect(isNewerVersion("v0.2.0", "0.1.99")).toBe(true);
    expect(isNewerVersion("v0.1.92", "0.1.92")).toBe(false);
    expect(isNewerVersion("v0.1.91", "0.1.92")).toBe(false);
    expect(isNewerVersion("nightly", "0.1.92")).toBe(false);
    expect(isNewerVersion("v0.1.93", "unknown")).toBe(false);
    expect(isNewerVersion("v0.1.93", "0.1.93-rc.1")).toBe(true);
    expect(isNewerVersion("v0.1.93-rc.2", "0.1.93-rc.1")).toBe(true);
    expect(isNewerVersion("v0.1.93-rc.10", "0.1.93-rc.9")).toBe(true);
    expect(isNewerVersion("v0.1.93-rc.1", "0.1.93")).toBe(false);
    expect(isNewerVersion("v0.1.93-rc.1", "0.1.93-rc.1")).toBe(false);
    expect(isNewerVersion("v0.1.93-rc.1.1", "0.1.93-rc.1")).toBe(true);
  });

  it("follows the stable channel, not the newest release, and gives the update command for this install", async () => {
    const fetch = github("v0.1.95", "0.1.93");
    const check = createUpdateChecker({ current: "0.1.92", install: "docker", fetch });
    expect(await check()).toEqual({
      current: "0.1.92",
      install: "docker",
      channel: "stable",
      latest: "0.1.93",
      available: true,
      releaseUrl: "https://github.com/milind-soni/OpenMausBot/releases/tag/v0.1.93",
      command: "git pull && ./update.sh",
      restart: false,
      checkedAt: expect.any(String), behind: 1, behindExact: true,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledWith(STABLE_CHANNEL_URL, expect.anything());
    expect(await createUpdateChecker({ current: "0.1.92", install: "npm", fetch })()).toMatchObject({ latest: "0.1.93", command: "npm install -g openmausbot@0.1.93", restart: true });
  });

  it("offers nothing to a server that is already on the stable version or past it", async () => {
    expect(await createUpdateChecker({ current: "0.1.93", install: "docker", fetch: github("v0.1.95", "0.1.93") })()).toMatchObject({ channel: "stable", latest: "0.1.93", available: false });
    expect(await createUpdateChecker({ current: "0.1.95", install: "docker", fetch: github("v0.1.95", "0.1.93") })()).toMatchObject({ available: false });
  });

  it("goes by the newest release until a first version has been promoted, or when the owner asked for every release", async () => {
    const unpromoted = github("v0.1.93", null);
    expect(await createUpdateChecker({ current: "0.1.92", install: "docker", fetch: unpromoted })()).toMatchObject({
      channel: "newest", latest: "0.1.93", available: true, command: "git pull && ./update.sh --version 0.1.93",
    });
    expect(unpromoted).toHaveBeenCalledWith(LATEST_RELEASE_URL, expect.anything());
    const fetch = github("v0.1.95", "0.1.93");
    expect(await createUpdateChecker({ current: "0.1.92", install: "docker", channel: "newest", fetch })()).toMatchObject({ channel: "newest", latest: "0.1.95" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(updateChannel({})).toBe("stable");
    expect(updateChannel({ OMB_UPDATE_CHANNEL: " Newest " })).toBe("newest");
    expect(updateChannel({ OMB_UPDATE_CHANNEL: "latest" })).toBe("stable");
  });

  it("does not take a broken channel record for a version, or fall back past it", async () => {
    const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ version: "0.1.93-rc.1" }) }) as Response);
    await expect(createUpdateChecker({ current: "0.1.92", install: "docker", fetch })()).rejects.toThrow("The stable channel named no version");
    fetch.mockImplementation(async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response);
    await expect(createUpdateChecker({ current: "0.1.92", install: "docker", fetch })()).rejects.toThrow("The stable channel answered 500");
  });

  it("gives the last answer while the channel cannot be read, for a day, and never the newest release instead", async () => {
    let now = 0;
    let down = false;
    const fetch = vi.fn(async (url: string | URL | Request) => {
      if (down) return { ok: false, status: 503, json: async () => ({}) } as Response;
      return String(url) === STABLE_CHANNEL_URL ? promoted("0.1.93") : release("v0.1.99");
    });
    const check = createUpdateChecker({ current: "0.1.92", install: "docker", fetch, now: () => now });
    expect(await check()).toMatchObject({ channel: "stable", latest: "0.1.93", available: true });
    down = true;
    now = 2 * 60 * 60_000;
    expect(await check()).toMatchObject({ channel: "stable", latest: "0.1.93", available: true });
    expect(fetch.mock.calls.map(([url]) => String(url))).not.toContain(LATEST_RELEASE_URL);
    now = 25 * 60 * 60_000;
    await expect(check()).rejects.toThrow("The stable channel answered 503");
  });

  it("says up to date, and asks at most once an hour", async () => {
    let now = 0;
    const fetch = github("v0.1.92", "0.1.92");
    const check = createUpdateChecker({ current: "0.1.92", install: "npm", fetch, now: () => now });
    expect(await check()).toMatchObject({ available: false, latest: "0.1.92", command: "npm install -g openmausbot@0.1.92", restart: true });
    now = 59 * 60_000;
    await check();
    expect(fetch).toHaveBeenCalledTimes(1);
    now = 61 * 60_000;
    await check();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not look anything up for a desktop or hosted server", async () => {
    const fetch = vi.fn();
    for (const install of ["desktop", "managed"] as const) {
      expect(await createUpdateChecker({ current: "0.1.92", install, fetch })()).toEqual({ current: "0.1.92", install, available: false });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails clearly when GitHub cannot be reached, and tries again next time", async () => {
    const fetch = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) }) as Response);
    const check = createUpdateChecker({ current: "0.1.92", install: "git", channel: "newest", fetch });
    await expect(check()).rejects.toThrow("GitHub answered 403");
    await expect(check()).rejects.toThrow("GitHub answered 403");
    const recovered = createUpdateChecker({ current: "0.1.92", install: "git", channel: "newest", fetch: async () => release("v0.1.93") });
    expect(await recovered()).toMatchObject({ available: true, command: "git pull && pnpm install", restart: true });
  });
});

describe("release distance", () => {
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  it("counts published stable releases, not the difference between version numbers", async () => {
    const fetch = vi.fn(async (url: unknown) => String(url).endsWith("/latest") ? release("v0.1.150") : reply([
      { tag_name: "v0.1.150" }, { tag_name: "v0.1.140" }, { tag_name: "0.1.140" },
      { tag_name: "v0.1.139", draft: true }, { tag_name: "v0.1.149-rc.1", prerelease: true },
      { tag_name: "android-v1.5.0" }, { tag_name: "v0.1.137" }, { tag_name: "v0.2.0" },
    ]));
    const check = createUpdateChecker({ current: "0.1.138+dmxo.1", install: "docker", channel: "newest", fetch });
    const values = await Promise.all([check(), check(), check()]);
    expect(values[0]).toMatchObject({ latest: "0.1.150", behind: 2, behindExact: true });
    expect(values[1]).toEqual(values[0]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("reads a second history page before calling the count exact", async () => {
    const fetch = vi.fn(async (url: unknown) => String(url).endsWith("/latest") ? release("v0.2.0")
      : String(url).endsWith("page=1") ? reply(Array.from({ length: 100 }, () => ({ tag_name: "v0.1.139" })))
        : reply([{ tag_name: "v0.2.0" }, { tag_name: "v0.1.140" }]));
    expect(await createUpdateChecker({ current: "0.1.138", install: "docker", channel: "newest", fetch })()).toMatchObject({ behind: 3, behindExact: true });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("reports a lower bound if the bounded history does not reach its end", async () => {
    const fetch = vi.fn(async (url: unknown) => String(url).endsWith("/latest") ? release("v0.2.0")
      : reply(Array.from({ length: 100 }, () => ({ tag_name: "v0.1.139" }))));
    expect(await createUpdateChecker({ current: "0.1.138", install: "docker", channel: "newest", fetch })()).toMatchObject({ behind: 2, behindExact: false });
    expect(fetch).toHaveBeenCalledTimes(6);
  });
  it("keeps the latest version but leaves the distance unknown when history fails", async () => {
    const fetch = vi.fn(async (url: unknown) => String(url).endsWith("/latest") ? release("v0.1.140") : reply({}, 403));
    const result = await createUpdateChecker({ current: "0.1.138", install: "docker", channel: "newest", fetch })();
    expect(result).toMatchObject({ available: true, latest: "0.1.140", historyUnavailable: true });
    expect(result.behind).toBeUndefined();
  });
  it("returns the last successful status as stale after a refresh failure", async () => {
    let now = 0;
    const fetch = vi.fn(async () => release("v0.1.138"));
    const check = createUpdateChecker({ current: "0.1.138", install: "docker", channel: "newest", fetch, now: () => now });
    const first = await check();now = 61 * 60_000;
    fetch.mockImplementation(async () => reply({}, 429));
    expect(await check()).toEqual({ ...first, stale: true });
    expect(await check()).toEqual({ ...first, stale: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("never calls an unknown installation version up to date", async () => {
    await expect(createUpdateChecker({ current: "dev", install: "docker", channel: "newest", fetch: async () => release("v0.1.140") })()).rejects.toThrow("cannot be compared");
  });
  it("constructs release links from the trusted repository and tag", async () => {
    const fetch = vi.fn(async () => reply({ tag_name: "v0.1.138", html_url: "javascript:alert(1)" }));
    expect((await createUpdateChecker({ current: "0.1.138", install: "docker", channel: "newest", fetch })()).releaseUrl).toBe("https://github.com/milind-soni/OpenMausBot/releases/tag/v0.1.138");
  });
});
