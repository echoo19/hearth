import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ASSET_PACK_MAX_FILE_BYTES,
  ASSET_PACK_MAX_FILES,
  createProject,
  HearthSession,
  inspectAssetPack,
  listCommands,
  MemoryFileSystem,
} from "@hearth/core";
import { NodeFileSystem } from "@hearth/core/node";

function pngHeader(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    0,
    0,
    0,
    13,
    0x49,
    0x48,
    0x44,
    0x52,
    (width >>> 24) & 0xff,
    (width >>> 16) & 0xff,
    (width >>> 8) & 0xff,
    width & 0xff,
    (height >>> 24) & 0xff,
    (height >>> 16) & 0xff,
    (height >>> 8) & 0xff,
    height & 0xff,
  ]);
}

function sizedPng(width: number, height: number, size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set(pngHeader(width, height));
  return bytes;
}

async function setup() {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, "/proj", {
    name: "Pack Inspector",
  });
  return { fs, session: HearthSession.fromStore(store) };
}

describe("inspectAssetPack", () => {
  it("is registered as a read-only, non-mutating command", () => {
    const command = listCommands().find(
      (entry) => entry.name === "inspectAssetPack",
    );
    expect(command).toMatchObject({ permission: "read-only", mutates: false });
  });

  it("reports deterministic image, provenance, TMX, and TSX facts without changing the project", async () => {
    const { fs, session } = await setup();
    await fs.mkdir("/packs/dungeon");
    await fs.writeFile("/packs/dungeon/LICENSE.txt", "CC0 1.0");
    await fs.writeFile("/packs/dungeon/tiles.png", pngHeader(64, 96));
    await fs.writeFile(
      "/packs/dungeon/tiles.tsx",
      `
      <tileset tilewidth="32" tileheight="32" tilecount="6" columns="2"
        objectalignment="bottom"><tileoffset x="0" y="-32"/>
        <image source="tiles.png" width="64" height="96"/>
        <wangsets><wangset name="Walls" type="mixed"/></wangsets>
        <tile id="0"><objectgroup><object id="1"/></objectgroup></tile>
      </tileset>`,
    );
    await fs.writeFile(
      "/packs/dungeon/sample.tmx",
      `
      <map orientation="orthogonal" width="2" height="2"
        tilewidth="32" tileheight="32">
        <tileset firstgid="1" source="tiles.tsx"/>
        <layer name="Floor"><data encoding="csv">1,2,3,4</data></layer>
        <objectgroup name="Collision"/>
      </map>`,
    );

    const result = await session.execute<any>("inspectAssetPack", {
      path: "/packs/dungeon",
      sourceUrl: "https://example.test/dungeon",
      author: "Example",
      license: "CC0-1.0",
    });

    expect(result.success).toBe(true);
    expect(result.changed).toEqual([]);
    expect(result.files).toEqual([]);
    expect(result.data.root).toBe("/packs/dungeon");
    expect(result.data.status).toBe("partial");
    expect(result.data.provenance).toEqual({
      sourceUrl: "https://example.test/dungeon",
      author: "Example",
      license: "CC0-1.0",
      evidenceFiles: ["LICENSE.txt"],
    });
    expect(result.data.files.map((f: any) => f.path)).toEqual([
      "LICENSE.txt",
      "sample.tmx",
      "tiles.png",
      "tiles.tsx",
    ]);
    expect(result.data.images).toEqual([
      {
        path: "tiles.png",
        width: 64,
        height: 96,
        format: "png",
        referencedBy: ["tiles.tsx"],
      },
    ]);
    expect(result.data.reviewImages).toEqual(["tiles.png"]);
    expect(result.data.maps[0].layers.map((l: any) => l.name)).toEqual([
      "Floor",
      "Collision",
    ]);
    expect(result.data.maps[0].tilesets[0]).toMatchObject({
      firstGid: 1,
      source: "tiles.tsx",
      tileWidth: 32,
      tileHeight: 32,
      columns: 2,
      tileOffset: { x: 0, y: -32 },
      objectAlignment: "bottom",
      wangSetCount: 1,
    });
    expect(result.data.diagnostics.map((d: any) => d.code)).toEqual(
      expect.arrayContaining([
        "PACK_VISUAL_REVIEW_REQUIRED",
        "PACK_OBJECT_LAYER_UNSUPPORTED",
        "PACK_TILE_OFFSET_UNSUPPORTED",
        "PACK_COLLISION_NOT_IMPORTED",
        "PACK_TERRAIN_RULES_NOT_IMPORTED",
      ]),
    );
  });

  it("analyzes Tiled JSON and rejects isometric maps and flipped gids", async () => {
    const { fs, session } = await setup();
    await fs.mkdir("/packs/iso");
    await fs.writeFile("/packs/iso/sheet.png", pngHeader(128, 64));
    await fs.writeFile(
      "/packs/iso/map.json",
      JSON.stringify({
        type: "map",
        orientation: "isometric",
        width: 2,
        height: 1,
        tilewidth: 32,
        tileheight: 16,
        layers: [
          {
            name: "Ground",
            type: "tilelayer",
            visible: true,
            opacity: 0.5,
            data: [0x80000001, 2],
          },
          { name: "Props", type: "objectgroup", objects: [] },
        ],
        tilesets: [
          {
            firstgid: 1,
            name: "mixed",
            tilewidth: 32,
            tileheight: 32,
            columns: 4,
            image: "sheet.png",
            imagewidth: 128,
            imageheight: 64,
            tileoffset: { x: 1, y: -2 },
            wangsets: [{ name: "Terrain" }],
            tiles: [{ id: 0, objectgroup: { objects: [] } }],
          },
        ],
      }),
    );

    const result = await session.execute<any>("inspectAssetPack", {
      path: "/packs/iso",
    });
    expect(result.success).toBe(true);
    expect(result.data.status).toBe("unsupported");
    expect(result.data.maps[0]).toMatchObject({
      path: "map.json",
      format: "tiled-json",
      orientation: "isometric",
      tileWidth: 32,
      tileHeight: 16,
      width: 2,
      height: 1,
    });
    expect(result.data.images[0].referencedBy).toEqual(["map.json"]);
    expect(result.data.diagnostics.map((d: any) => d.code)).toEqual(
      expect.arrayContaining([
        "PACK_LICENSE_UNKNOWN",
        "PACK_ISOMETRIC_UNSUPPORTED",
        "PACK_TILE_FLIPS_UNSUPPORTED",
        "PACK_OBJECT_LAYER_UNSUPPORTED",
        "PACK_TILE_OFFSET_UNSUPPORTED",
        "PACK_MIXED_TILE_SIZE",
        "PACK_OVERSIZED_TILE",
        "PACK_COLLISION_NOT_IMPORTED",
        "PACK_TERRAIN_RULES_NOT_IMPORTED",
      ]),
    );
  });

  it("reports missing Tiled metadata for an image-only pack", async () => {
    const { fs, session } = await setup();
    await fs.mkdir("/packs/loose");
    await fs.writeFile("/packs/loose/b.png", pngHeader(16, 16));
    await fs.writeFile("/packs/loose/a.png", pngHeader(16, 16));

    const result = await session.execute<any>("inspectAssetPack", {
      path: "/packs/loose",
      license: "CC0-1.0",
    });
    expect(result.success).toBe(true);
    expect(result.data.reviewImages).toEqual(["a.png", "b.png"]);
    expect(result.data.diagnostics.map((d: any) => d.code)).toContain(
      "PACK_METADATA_MISSING",
    );
  });

  it("tracks images referenced by authored map image layers", async () => {
    const { fs, session } = await setup();
    await fs.mkdir("/packs/backdrop");
    await fs.writeFile("/packs/backdrop/background.png", pngHeader(320, 180));
    await fs.writeFile(
      "/packs/backdrop/map.tmx",
      `
      <map orientation="orthogonal" width="1" height="1" tilewidth="16" tileheight="16">
        <imagelayer name="Backdrop"><image source="background.png"/></imagelayer>
      </map>`,
    );

    const result = await session.execute<any>("inspectAssetPack", {
      path: "/packs/backdrop",
      license: "CC0-1.0",
    });
    expect(result.data.images[0].referencedBy).toEqual(["map.tmx"]);
  });

  it("rejects a path that is not a directory", async () => {
    const { fs, session } = await setup();
    await fs.writeFile("/packs/not-a-directory.png", pngHeader(16, 16));
    const result = await session.execute("inspectAssetPack", {
      path: "/packs/not-a-directory.png",
    });
    expect(result.success).toBe(false);
  });

  it("recognizes a native TMJ map and its unsupported orientation", async () => {
    const { fs, session } = await setup();
    await fs.mkdir("/packs/native");
    await fs.writeFile(
      "/packs/native/map.tmj",
      JSON.stringify({
        type: "map",
        orientation: "isometric",
        width: 1,
        height: 1,
        tilewidth: 32,
        tileheight: 16,
        layers: [],
        tilesets: [],
      }),
    );

    const result = await session.execute<any>("inspectAssetPack", {
      path: "/packs/native",
      license: "CC0-1.0",
    });

    expect(result.data.files).toContainEqual({ path: "map.tmj", kind: "map" });
    expect(result.data.maps).toHaveLength(1);
    expect(result.data.status).toBe("unsupported");
    expect(result.data.diagnostics.map((d: any) => d.code)).toContain(
      "PACK_ISOMETRIC_UNSUPPORTED",
    );
  });

  it.each(["tiles.json", "tiles.tsj"])(
    "recognizes standalone Tiled tileset metadata in %s",
    async (name) => {
      const { fs, session } = await setup();
      await fs.mkdir("/packs/tileset");
      await fs.writeFile("/packs/tileset/sheet.png", pngHeader(16, 16));
      await fs.writeFile(
        `/packs/tileset/${name}`,
        JSON.stringify({
          type: "tileset",
          tilewidth: 16,
          tileheight: 16,
          columns: 1,
          image: "sheet.png",
          imagewidth: 16,
          imageheight: 16,
        }),
      );

      const result = await session.execute<any>("inspectAssetPack", {
        path: "/packs/tileset",
        license: "CC0-1.0",
      });

      expect(result.data.files).toContainEqual({ path: name, kind: "tileset" });
      expect(result.data.images[0].referencedBy).toEqual([name]);
      expect(result.data.diagnostics.map((d: any) => d.code)).not.toContain(
        "PACK_METADATA_MISSING",
      );
    },
  );

  it.each([
    ["missing", undefined],
    ["malformed", "{not json"],
    ["oversized", " ".repeat(ASSET_PACK_MAX_FILE_BYTES + 1)],
  ])(
    "preserves %s external tileset references and reports missing metadata",
    async (_case, contents) => {
      const { fs, session } = await setup();
      await fs.mkdir("/packs/external");
      if (contents !== undefined)
        await fs.writeFile("/packs/external/tiles.json", contents);
      await fs.writeFile(
        "/packs/external/map.json",
        JSON.stringify({
          type: "map",
          orientation: "orthogonal",
          width: 1,
          height: 1,
          tilewidth: 16,
          tileheight: 16,
          layers: [],
          tilesets: [{ firstgid: 1, source: "tiles.json" }],
        }),
      );

      const result = await session.execute<any>("inspectAssetPack", {
        path: "/packs/external",
        license: "CC0-1.0",
      });

      expect(result.data.maps[0].tilesets).toEqual([
        { firstGid: 1, source: "tiles.json" },
      ]);
      expect(result.data.status).toBe("partial");
      expect(result.data.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "PACK_METADATA_MISSING",
          evidence: ["map.json", "tiles.json"],
        }),
      );
    },
  );

  it("retains oversized image evidence but excludes it from bounded visual review", async () => {
    const { fs, session } = await setup();
    await fs.mkdir("/packs/large");
    await fs.writeFile(
      "/packs/large/atlas.png",
      sizedPng(2048, 2048, ASSET_PACK_MAX_FILE_BYTES + 1),
    );

    const result = await session.execute<any>("inspectAssetPack", {
      path: "/packs/large",
      license: "CC0-1.0",
    });

    expect(result.data.images).toEqual([
      { path: "atlas.png", referencedBy: [] },
    ]);
    expect(result.data.reviewImages).toEqual([]);
    expect(result.data.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "PACK_FILE_LIMIT_EXCEEDED",
        evidence: ["atlas.png"],
      }),
    );
  });

  it("bounds aggregate file reads and reports images omitted from review", async () => {
    const { fs, session } = await setup();
    await fs.mkdir("/packs/many-large");
    const bytes = sizedPng(1024, 1024, ASSET_PACK_MAX_FILE_BYTES);
    for (let index = 0; index < 9; index++) {
      await fs.writeFile(`/packs/many-large/${index}.png`, bytes);
    }

    const result = await session.execute<any>("inspectAssetPack", {
      path: "/packs/many-large",
      license: "CC0-1.0",
    });

    expect(result.data.images).toHaveLength(9);
    expect(
      result.data.images.filter((image: any) => image.width !== undefined),
    ).toHaveLength(8);
    expect(result.data.reviewImages).toHaveLength(8);
    expect(result.data.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "PACK_FILE_LIMIT_EXCEEDED",
        evidence: ["8.png"],
      }),
    );
  });

  it("rejects packs over the file-count limit", async () => {
    const fs = new MemoryFileSystem();
    await fs.mkdir("/packs/files");
    for (let index = 0; index <= ASSET_PACK_MAX_FILES; index++) {
      await fs.writeFile(`/packs/files/${index}.txt`, "");
    }

    await expect(
      inspectAssetPack(fs, { path: "/packs/files" }),
    ).rejects.toThrow(`Asset pack exceeds ${ASSET_PACK_MAX_FILES} files`);
  });

  it("bounds visited directory entries", async () => {
    const entryCount = 8193;
    const fs = {
      exists: async () => true,
      stat: async (candidate: string) => ({
        isDirectory: candidate === "/pack" || candidate.startsWith("/pack/d"),
        size: 0,
        mtimeMs: 0,
      }),
      realpath: async (candidate: string) => candidate,
      readdir: async (candidate: string) =>
        candidate === "/pack"
          ? Array.from({ length: entryCount }, (_, index) => `d${index}`)
          : [],
    } as any;

    await expect(inspectAssetPack(fs, { path: "/pack" })).rejects.toThrow(
      /entries/i,
    );
  });

  it("skips symlinks that escape the canonical pack root", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "hearth-pack-"));
    const pack = path.join(temp, "pack");
    const outside = path.join(temp, "outside.png");
    try {
      await writeFile(outside, pngHeader(16, 16));
      await new NodeFileSystem().mkdir(pack);
      await symlink(outside, path.join(pack, "escape.png"));

      const report = await inspectAssetPack(new NodeFileSystem(), {
        path: pack,
        license: "CC0-1.0",
      });

      expect(report.files).toEqual([]);
      expect(report.reviewImages).toEqual([]);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("reports malformed TMX and JSON as missing metadata without throwing", async () => {
    const { fs, session } = await setup();
    await fs.mkdir("/packs/malformed");
    await fs.writeFile("/packs/malformed/map.tmx", "<map><layer></map>");
    await fs.writeFile("/packs/malformed/map.json", "{not json");

    const result = await session.execute<any>("inspectAssetPack", {
      path: "/packs/malformed",
      license: "CC0-1.0",
    });

    expect(result.success).toBe(true);
    expect(result.data.maps).toEqual([]);
    expect(result.data.diagnostics.map((d: any) => d.code)).toContain(
      "PACK_METADATA_MISSING",
    );
    expect(result.data.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "PACK_METADATA_INVALID",
        evidence: ["map.json", "map.tmx"],
      }),
    );
  });

  it("rejects a missing pack path", async () => {
    const { session } = await setup();
    const result = await session.execute("inspectAssetPack", {
      path: "/packs/missing",
    });
    expect(result.success).toBe(false);
  });

  it("uses code-point ordering for deterministic image reports", async () => {
    const { fs, session } = await setup();
    await fs.mkdir("/packs/order");
    await fs.writeFile("/packs/order/a.png", pngHeader(16, 16));
    await fs.writeFile("/packs/order/Z.png", pngHeader(16, 16));

    const result = await session.execute<any>("inspectAssetPack", {
      path: "/packs/order",
      license: "CC0-1.0",
    });

    expect(result.data.reviewImages).toEqual(["Z.png", "a.png"]);
  });

  it("does not mark a zero tile offset as unsupported", async () => {
    const { fs, session } = await setup();
    await fs.mkdir("/packs/offset");
    await fs.writeFile(
      "/packs/offset/tiles.tsx",
      `
      <tileset tilewidth="16" tileheight="16"><tileoffset x="0" y="0"/></tileset>`,
    );
    await fs.writeFile(
      "/packs/offset/map.tmx",
      `
      <map orientation="orthogonal" width="1" height="1" tilewidth="16" tileheight="16">
        <tileset firstgid="1" source="tiles.tsx"/>
        <layer name="Floor"><data encoding="csv">0</data></layer>
      </map>`,
    );

    const result = await session.execute<any>("inspectAssetPack", {
      path: "/packs/offset",
      license: "CC0-1.0",
    });

    expect(result.data.maps[0].tilesets[0].tileOffset).toEqual({ x: 0, y: 0 });
    expect(result.data.diagnostics.map((d: any) => d.code)).not.toContain(
      "PACK_TILE_OFFSET_UNSUPPORTED",
    );
  });

  it("accepts contract-normalized Windows canonical paths", async () => {
    class WindowsFileSystem extends MemoryFileSystem {
      override async realpath(candidate: string): Promise<string> {
        const canonical = await super.realpath(candidate);
        return `C:${canonical}`;
      }
    }
    const fs = new WindowsFileSystem();
    await fs.mkdir("/pack");
    await fs.writeFile("/pack/tiles.png", pngHeader(16, 16));

    const report = await inspectAssetPack(fs, {
      path: "/pack",
      license: "CC0-1.0",
    });

    expect(report.root).toBe("C:/pack");
    expect(report.files).toContainEqual({ path: "tiles.png", kind: "image" });
  });

  it.skipIf(process.platform === "win32")(
    "keeps literal POSIX backslashes opaque when checking symlink containment",
    async () => {
      const temp = await mkdtemp(path.join(tmpdir(), "hearth-pack-slash-"));
      const pack = path.join(temp, "pack\\literal");
      const outside = path.join(temp, "outside.png");
      try {
        await writeFile(outside, pngHeader(16, 16));
        await new NodeFileSystem().mkdir(pack);
        await symlink(outside, path.join(pack, "escape.png"));

        const report = await inspectAssetPack(new NodeFileSystem(), {
          path: pack,
          license: "CC0-1.0",
        });

        expect(report.root).toMatch(/pack\\literal$/);
        expect(report.files).toEqual([]);
      } finally {
        await rm(temp, { recursive: true, force: true });
      }
    },
  );

  it("marks unreadable image files partial with exact evidence", async () => {
    const { fs, session } = await setup();
    await fs.mkdir("/packs/bad-image");
    await fs.writeFile("/packs/bad-image/bad.png", "not an image");
    await fs.writeFile(
      "/packs/bad-image/map.json",
      JSON.stringify({
        type: "map",
        orientation: "orthogonal",
        width: 1,
        height: 1,
        tilewidth: 16,
        tileheight: 16,
        layers: [],
        tilesets: [],
      }),
    );

    const result = await session.execute<any>("inspectAssetPack", {
      path: "/packs/bad-image",
      license: "CC0-1.0",
    });

    expect(result.data.status).toBe("partial");
    expect(result.data.reviewImages).toEqual([]);
    expect(result.data.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "PACK_IMAGE_INVALID",
        evidence: ["bad.png"],
      }),
    );
  });
});
