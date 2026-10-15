// fetch_and_index's network layer: address policy on every hop, hop limit, size cap.
import { afterAll, expect, test } from "bun:test";
import { checkUrl, classifyIp, fetchUrl } from "../src/fetch.ts";

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/imds") return Response.redirect("http://169.254.169.254/latest/meta-data", 302);
    if (path.startsWith("/loop")) return Response.redirect(`/loop${path.length}`, 302);
    if (path === "/json") return Response.json({ a: 1 });
    if (path === "/huge") {
      const chunk = new Uint8Array(1024 * 1024);
      let sent = 0;
      return new Response(new ReadableStream({ pull: (c) => (sent++ < 60 ? c.enqueue(chunk) : c.close()) }));
    }
    return new Response("not found", { status: 404 });
  },
});
afterAll(() => server.stop(true));
const base = `http://127.0.0.1:${server.port}`;

test("classifyIp: zone ids, v4-mapped and the IMDS range", () => {
  expect(classifyIp("::1%eth0")).toBe("private");
  expect(classifyIp("::ffff:169.254.169.254")).toBe("block");
  expect(classifyIp("192.168.1.1")).toBe("private");
  expect(classifyIp("93.184.216.34")).toBe("public");
});

test("loopback is allowed by default and refused under CTXMODE_FETCH_STRICT=1", async () => {
  expect(await checkUrl(`${base}/json`)).toBeNull();
  expect(await checkUrl("http://[::1]:1/")).toBeNull();
  expect(await checkUrl("file:///etc/passwd")).toContain("not allowed");
  process.env.CTXMODE_FETCH_STRICT = "1";
  try {
    expect(await checkUrl(`${base}/json`)).toContain("blocked under CTXMODE_FETCH_STRICT=1");
  } finally {
    delete process.env.CTXMODE_FETCH_STRICT;
  }
});

test("a redirect is checked before it is followed", async () => {
  await expect(fetchUrl(`${base}/imds`)).rejects.toThrow("redirect to http://169.254.169.254/latest/meta-data: URL \"169.254.169.254\" resolves to 169.254.169.254 — blocked");
  await expect(fetchUrl(`${base}/loop`)).rejects.toThrow("redirect chain exceeded 5 hops");
});

test("JSON is pretty-printed, HTTP errors and oversized bodies throw", async () => {
  expect(await fetchUrl(`${base}/json`)).toEqual({ kind: "json", text: '{\n  "a": 1\n}' });
  await expect(fetchUrl(`${base}/missing`)).rejects.toThrow("HTTP 404");
  await expect(fetchUrl(`${base}/huge`)).rejects.toThrow("response too large");
});
