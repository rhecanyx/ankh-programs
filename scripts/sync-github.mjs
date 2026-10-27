// Archive reviewed, unmodified releases only; never run upstream installers/build scripts.
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const repository = process.env.GITHUB_REPOSITORY,
  token = process.env.GITHUB_TOKEN;
if (repository !== "rhecanyx/ankh-programs" || !token)
  throw Error("Authorized repository required");
const root = new URL("../", import.meta.url),
  headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "Ankh-archive",
  };
async function api(path, body, method) {
  const r = await fetch("https://api.github.com" + path, {
    headers: { ...headers, "Content-Type": "application/json" },
    method: method ?? (body ? "POST" : "GET"),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!r.ok) throw Error(`GitHub ${r.status} ${path}`);
  return r.status === 204 ? null : r.json();
}
const profiles = {
  voicestudio: {
    repo: "debpalash/VoiceStudio",
    tag: /^v(\d+\.\d+\.\d+)$/,
    licenses: ["LICENSE", "LICENSE-NOTICE.md"],
    checksums: true,
  },
  ghidra: {
    repo: "NationalSecurityAgency/ghidra",
    tag: /^Ghidra_(\d+\.\d+(?:\.\d+)?)_build$/,
    licenses: ["LICENSE", "NOTICE", "DISCLAIMER.md"],
    checksums: false,
  },
};
const configs = JSON.parse(
  await readFile(new URL("programs.json", root), "utf8"),
);
const catalog = JSON.parse(
  await readFile(new URL("catalog.json", root), "utf8"),
);
let failures = 0;
for (const config of configs.filter(
  (c) => c.archiveMode === "github-release",
)) {
  try {
    const profile = profiles[config.id];
    if (!profile || config.upstream !== profile.repo)
      throw Error("Unreviewed upstream");
    const upstream = await api(`/repos/${profile.repo}/releases/latest`),
      match = profile.tag.exec(upstream.tag_name);
    if (!match || upstream.draft || upstream.prerelease)
      throw Error("Stable reviewed tag required");
    const version =
        match[1].split(".").length === 2 ? match[1] + ".0" : match[1],
      tag = `${config.id}-v${version}`;
    const previous = catalog.programs.find((p) => p.id === config.id);
    if (previous?.version === version) {
      const before = JSON.stringify(previous);
      Object.assign(previous, {
        name: config.name,
        description: config.description,
        guide: config.guide,
        license: config.license,
      });
      if (before !== JSON.stringify(previous)) {
        catalog.updatedAt = new Date().toISOString();
        await writeFile(
          new URL("catalog.json", root),
          JSON.stringify(catalog, null, 2) + "\n",
        );
      }
      console.log(config.id + ": current " + version);
      continue;
    }
    const releases = await api(`/repos/${repository}/releases?per_page=100`);
    let release = releases.find((r) => r.tag_name === tag);
    if (release && !release.draft)
      throw Error(
        "Published release has no matching catalog; inspect manually",
      );
    const commit = (
      await api(
        `/repos/${profile.repo}/commits/${encodeURIComponent(upstream.tag_name)}`,
      )
    ).sha;
    let sums = "";
    if (profile.checksums) {
      const a = upstream.assets.find((a) => a.name === "SHA256SUMS.txt");
      if (!a) throw Error("Checksums missing");
      const r = await fetch(a.browser_download_url);
      if (!r.ok) throw Error("Checksums unavailable");
      sums = await r.text();
    }
    const files = new Map(),
      assets = [];
    for (const target of config.assets) {
      const candidates = upstream.assets.filter((a) =>
        a.name.endsWith(target.suffix),
      );
      if (candidates.length !== 1) throw Error("Ambiguous/missing installer");
      const a = candidates[0];
      if (!a.digest?.match(/^sha256:[a-f0-9]{64}$/) || a.size > 2147483648)
        throw Error("Upstream digest/size invalid");
      let file = files.get(a.name);
      if (!file) {
        const r = await fetch(a.browser_download_url);
        if (!r.ok) throw Error("Installer download failed");
        const bytes = Buffer.from(await r.arrayBuffer()),
          sha = createHash("sha256").update(bytes).digest("hex");
        if (a.digest !== "sha256:" + sha || bytes.length !== a.size)
          throw Error("Installer integrity failure");
        if (
          profile.checksums &&
          !sums.split("\n").some(
            (l) =>
              l
                .trim()
                .split(/\s+\*?/)
                .join(" ") === `${sha} ${a.name}`,
          )
        )
          throw Error("Upstream checksum mismatch");
        file = { bytes, sha };
        files.set(a.name, file);
      }
      assets.push({
        platform: target.platform,
        arch: target.arch,
        name: a.name,
        url: `https://github.com/${repository}/releases/download/${tag}/${a.name}`,
        size: a.size,
        sha256: file.sha,
      });
    }
    for (const name of profile.licenses) {
      const data = await api(
        `/repos/${profile.repo}/contents/${name}?ref=${commit}`,
      );
      files.set(name, {
        bytes: Buffer.from(data.content.replace(/\n/g, ""), "base64"),
      });
    }
    const src = await fetch(
      `https://api.github.com/repos/${profile.repo}/tarball/${commit}`,
      { headers },
    );
    if (!src.ok) throw Error("Source snapshot unavailable");
    files.set(`${config.id}-source-${commit}.tar.gz`, {
      bytes: Buffer.from(await src.arrayBuffer()),
    });
    files.set("SOURCE.json", {
      bytes: Buffer.from(
        JSON.stringify(
          {
            upstream: profile.repo,
            tag: upstream.tag_name,
            commit,
            mode: "unmodified-upstream-binaries",
            source:
              "Tagged source snapshot; not full Git history. Model weights, LFS payloads and external services require separate backups.",
          },
          null,
          2,
        ),
      ),
    });
    files.set("ATTRIBUTION.md", {
      bytes: Buffer.from(
        `${config.name}\nOriginal project: https://github.com/${profile.repo}\nRelease: ${upstream.html_url}\nLicense: ${config.license}\nUnmodified original binaries. Copyright, trademarks and third-party rights remain with their owners. See included source snapshot, license and notice files.\n`,
      ),
    });
    for (const f of files.values())
      f.sha ??= createHash("sha256").update(f.bytes).digest("hex");
    files.set("SHA256SUMS.txt", {
      bytes: Buffer.from(
        [...files].map(([name, f]) => `${f.sha}  ${name}`).join("\n") + "\n",
      ),
    });
    release ??= await api(`/repos/${repository}/releases`, {
      tag_name: tag,
      name: `${config.name} ${version} — özgün paket arşivi`,
      draft: true,
      body: `${upstream.html_url} özgün paketleri değiştirilmeden arşivlenmiştir. Kaynak, ${commit} commit'inin tar.gz anlık görüntüsüdür; tam Git geçmişi değildir. Lisans/atıf dosyaları ve sağlama değerleri ektedir. ${config.guide}`,
    });
    for (const [name, file] of files) {
      const digest =
        "sha256:" + createHash("sha256").update(file.bytes).digest("hex");
      const old = release.assets.find((a) => a.name === name);
      if (old) {
        if (old.digest !== digest)
          throw Error("Existing draft bytes differ: " + name);
        continue;
      }
      const r = await fetch(
        `https://uploads.github.com/repos/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
        {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/octet-stream" },
          body: file.bytes,
        },
      );
      if (!r.ok) throw Error("Upload failed " + name);
      const saved = await r.json();
      if (saved.digest !== digest) throw Error("Upload digest differs");
      console.log("Verified " + name);
    }
    await api(
      `/repos/${repository}/releases/${release.id}`,
      { draft: false },
      "PATCH",
    );
    catalog.programs = catalog.programs
      .filter((p) => p.id !== config.id)
      .concat({
        id: config.id,
        name: config.name,
        version,
        description: config.description,
        guide: config.guide,
        license: config.license,
        upstream: config.upstream,
        releaseUrl: `https://github.com/${repository}/releases/tag/${tag}`,
        assets,
      });
    catalog.updatedAt = new Date().toISOString();
    await writeFile(
      new URL("catalog.json", root),
      JSON.stringify(catalog, null, 2) + "\n",
    );
  } catch (e) {
    failures++;
    console.error(config.id + ": " + e.message);
  }
}
if (failures) process.exitCode = 1;
