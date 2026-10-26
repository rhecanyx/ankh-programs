import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
const token = process.env.GITHUB_TOKEN;
const repository = process.env.GITHUB_REPOSITORY || "rhecanyx/ankh-programs";
if (!token || repository !== "rhecanyx/ankh-programs")
  throw Error("Authorized repository/token required");
const root = new URL("../", import.meta.url);
const programs = JSON.parse(
  await readFile(new URL("programs.json", root), "utf8"),
);
const headers = {
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "User-Agent": "Ankh-program-archive",
};
async function api(path, body, method) {
  const r = await fetch("https://api.github.com" + path, {
    headers: { ...headers, "Content-Type": "application/json" },
    method: method ?? (body ? "POST" : "GET"),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!r.ok) throw Error(`GitHub ${r.status}: ${path}`);
  return r.status === 204 ? null : r.json();
}
const releases = await api(`/repos/${repository}/releases?per_page=100`);
let previous = {
  schemaVersion: 1,
  updatedAt: new Date().toISOString(),
  programs: [],
};
try {
  previous = JSON.parse(await readFile(new URL("catalog.json", root), "utf8"));
} catch {}
const ids = new Set();
for (const config of programs) {
  if (ids.has(config.id)) throw Error("Duplicate program id: " + config.id);
  ids.add(config.id);
}
let failures = 0;
for (const config of programs) {
  try {
    if (
      !/^[a-z][a-z0-9-]{0,49}$/.test(config.id) ||
      !/^storytold\/[a-z0-9-]+$/.test(config.upstream)
    )
      throw Error("Invalid program config");
    const upstream = await api(`/repos/${config.upstream}/releases/latest`);
    if (
      upstream.draft ||
      upstream.prerelease ||
      !/^v?\d+\.\d+\.\d+$/.test(upstream.tag_name)
    )
      throw Error("Stable version required");
    const version = upstream.tag_name.replace(/^v/, "");
    const tag = `${config.id}-v${version}`;
    const existing = previous.programs.find((p) => p.id === config.id);
    if (existing?.version === version) {
      const before = JSON.stringify(existing);
      Object.assign(existing, {
        name: config.name,
        description: config.description,
        guide: config.guide,
        license: config.license,
      });
      if (before !== JSON.stringify(existing)) {
        previous.updatedAt = new Date().toISOString();
        await writeFile(
          new URL("catalog.json", root),
          JSON.stringify(previous, null, 2) + "\n",
        );
      }
      console.log(config.id + ": current " + version);
      continue;
    }
    let release = releases.find((r) => r.tag_name === tag);
    if (release && !release.draft)
      throw Error(
        "Published release already exists without matching catalog; inspect before changing",
      );
    release ??= await api(`/repos/${repository}/releases`, {
      tag_name: tag,
      name: `${config.name} ${version} — özgün paket arşivi`,
      draft: true,
      body: `${config.upstream} ${upstream.tag_name} paketlerinin değiştirilmemiş arşivi. Bu paketler Ankh tarafından yeniden derlenmemiştir. Kaynak geçmişi Git bundle içindedir. Kaynak: ${upstream.html_url}`,
    });
    const dir = await mkdtemp(join(tmpdir(), "ankh-program-"));
    try {
      const checksAsset = upstream.assets.find(
        (a) => a.name === "SHA256SUMS.txt",
      );
      if (!checksAsset) throw Error("Upstream checksums required");
      const checksResponse = await fetch(checksAsset.browser_download_url);
      if (!checksResponse.ok) throw Error("Checksum download failed");
      const checks = await checksResponse.text();
      const assets = [];
      async function upload(name, bytes) {
        const old = release.assets?.find((a) => a.name === name);
        if (old) {
          const actual = createHash("sha256").update(bytes).digest("hex");
          if (old.digest !== "sha256:" + actual)
            throw Error("Existing asset differs: " + name);
          return old;
        }
        const r = await fetch(
          `https://uploads.github.com/repos/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
          {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/octet-stream" },
            body: bytes,
          },
        );
        if (!r.ok) throw Error("Asset upload failed " + r.status + " " + name);
        return r.json();
      }
      for (const target of config.assets) {
        const a = upstream.assets.find((a) => a.name.endsWith(target.suffix));
        if (!a || a.size > 2e9 || !a.digest?.startsWith("sha256:"))
          throw Error("Missing/oversized asset");
        const r = await fetch(a.browser_download_url);
        if (!r.ok) throw Error("Download " + r.status);
        const bytes = Buffer.from(await r.arrayBuffer());
        const sha = createHash("sha256").update(bytes).digest("hex");
        const declared = checks
          .split("\n")
          .find((l) => l.trim().endsWith(a.name))
          ?.split(/\s+/)[0];
        if (
          sha !== declared ||
          a.digest !== "sha256:" + sha ||
          bytes.length !== a.size
        )
          throw Error("Integrity failure: " + a.name);
        const saved = await upload(a.name, bytes);
        assets.push({
          platform: target.platform,
          arch: target.arch,
          name: a.name,
          url: `https://github.com/${repository}/releases/download/${tag}/${a.name}`,
          size: bytes.length,
          sha256: sha,
        });
        console.log(a.name + ": SHA256 verified");
      }
      const git = join(dir, "source.git");
      execFileSync(
        "git",
        ["clone", "--mirror", `https://github.com/${config.upstream}.git`, git],
        { stdio: ["ignore", "ignore", "ignore"] },
      );
      const commit = execFileSync(
        "git",
        [
          "--git-dir",
          git,
          "rev-parse",
          `refs/tags/${upstream.tag_name}^{commit}`,
        ],
        { encoding: "utf8" },
      ).trim();
      const bundle = join(dir, `${config.id}-source-v${version}.bundle`);
      execFileSync(
        "git",
        ["--git-dir", git, "bundle", "create", bundle, "--all"],
        { stdio: "ignore" },
      );
      execFileSync("git", ["--git-dir", git, "bundle", "verify", bundle], {
        stdio: "ignore",
      });
      const sourceName = `${config.id}-source-v${version}.bundle`;
      const oldSource = release.assets?.find((a) => a.name === sourceName);
      if (oldSource) {
        // Git pack ordering can differ between mirror clones. Verify and retain the already uploaded source snapshot.
        const response = await fetch(oldSource.url, {
          headers: { ...headers, Accept: "application/octet-stream" },
        });
        if (!response.ok) throw Error("Source resume download failed");
        const bytes = Buffer.from(await response.arrayBuffer());
        if (
          oldSource.digest !==
          "sha256:" + createHash("sha256").update(bytes).digest("hex")
        )
          throw Error("Archived source integrity failure");
        const archived = join(dir, "archived.bundle");
        await writeFile(archived, bytes);
        execFileSync("git", ["--git-dir", git, "bundle", "verify", archived], {
          stdio: "ignore",
        });
        execFileSync(
          "git",
          [
            "--git-dir",
            git,
            "fetch",
            archived,
            `refs/tags/${upstream.tag_name}`,
          ],
          { stdio: "ignore" },
        );
        const archivedCommit = execFileSync(
          "git",
          ["--git-dir", git, "rev-parse", "FETCH_HEAD^{commit}"],
          { encoding: "utf8" },
        ).trim();
        if (archivedCommit !== commit)
          throw Error("Archived source tag changed");
      } else {
        await upload(sourceName, await readFile(bundle));
      }
      for (const file of [
        "LICENSE-MIT",
        "LICENSE-APACHE",
        "NOTICE",
        "ATTRIBUTION.md",
      ]) {
        const present = execFileSync(
          "git",
          ["--git-dir", git, "ls-tree", "--name-only", commit, file],
          { encoding: "utf8" },
        ).trim();
        if (!present && file === "ATTRIBUTION.md") {
          await upload(
            file,
            Buffer.from(
              `${config.name}: ${config.upstream} ${upstream.tag_name}\nUnmodified upstream binaries. Copyright and licensing remain with upstream contributors; see LICENSE-MIT, LICENSE-APACHE and NOTICE.\nSource: ${upstream.html_url}\n`,
            ),
          );
          continue;
        }
        const data = execFileSync("git", [
          "--git-dir",
          git,
          "show",
          `${commit}:${file}`,
        ]);
        await upload(file, data);
      }
      await upload(
        "SHA256SUMS.txt",
        Buffer.from(
          assets.map((a) => `${a.sha256}  ${a.name}`).join("\n") + "\n",
        ),
      );
      await upload(
        "SOURCE.json",
        Buffer.from(
          JSON.stringify(
            {
              upstream: config.upstream,
              tag: upstream.tag_name,
              commit,
              mode: "unmodified-upstream-binaries",
              note: "Git bundle archives Git history; external services, dependencies and Git LFS payloads require separate backups.",
            },
            null,
            2,
          ),
        ),
      );
      await api(
        `/repos/${repository}/releases/${release.id}`,
        { draft: false },
        "PATCH",
      );
      const entry = {
        id: config.id,
        name: config.name,
        version,
        description: config.description,
        license: config.license,
        guide: config.guide,
        upstream: config.upstream,
        releaseUrl: `https://github.com/${repository}/releases/tag/${tag}`,
        assets,
      };
      previous.programs = previous.programs
        .filter((p) => p.id !== entry.id)
        .concat(entry);
      previous.updatedAt = new Date().toISOString();
      await writeFile(
        new URL("catalog.json", root),
        JSON.stringify(previous, null, 2) + "\n",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  } catch (error) {
    failures++;
    console.error(config.id + ": " + error.message);
  }
}
if (failures) process.exitCode = 1;
