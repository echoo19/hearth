import { dirnamePath, joinPath, type FsLike } from "../fs.js";
import { probeImage } from "./imageInfo.js";

type DOMParserConstructor = typeof import("@xmldom/xmldom").DOMParser;

export const ASSET_PACK_MAX_FILES = 4096;
export const ASSET_PACK_MAX_FILE_BYTES = 8 * 1024 * 1024;
const ASSET_PACK_MAX_ENTRIES = 8192;
const ASSET_PACK_MAX_READ_BYTES = 64 * 1024 * 1024;
export const TILED_GID_FLAGS = 0xf0000000;

export type AssetPackStatus = "compatible" | "partial" | "unsupported";
export type AssetPackFileKind =
  | "image"
  | "audio"
  | "font"
  | "map"
  | "tileset"
  | "metadata"
  | "license"
  | "readme"
  | "other";

export interface AssetPackDiagnostic {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  evidence: string[];
  suggestion?: string;
}

export interface AssetPackImage {
  path: string;
  width?: number;
  height?: number;
  format?: string;
  referencedBy: string[];
}

export interface AssetPackLayer {
  name: string;
  type: string;
  visible?: boolean;
  opacity?: number;
  offsetX?: number;
  offsetY?: number;
}

export interface AssetPackTileset {
  firstGid?: number;
  source?: string;
  tileWidth?: number;
  tileHeight?: number;
  columns?: number;
  margin?: number;
  spacing?: number;
  tileOffset?: { x: number; y: number };
  objectAlignment?: string;
  wangSetCount?: number;
}

export interface AssetPackMap {
  path: string;
  format: "tmx" | "tiled-json";
  orientation?: string;
  tileWidth?: number;
  tileHeight?: number;
  width?: number;
  height?: number;
  layers: AssetPackLayer[];
  tilesets: AssetPackTileset[];
  features: string[];
}

export interface AssetPackReport {
  root: string;
  status: AssetPackStatus;
  provenance: {
    sourceUrl?: string;
    author?: string;
    license?: string;
    evidenceFiles: string[];
  };
  files: Array<{ path: string; kind: AssetPackFileKind }>;
  images: AssetPackImage[];
  maps: AssetPackMap[];
  diagnostics: AssetPackDiagnostic[];
  reviewImages: string[];
  reviewChecklist: string[];
  contactSheet?: string;
}

interface PackParams {
  path: string;
  sourceUrl?: string;
  author?: string;
  license?: string;
}

interface TilesetFacts {
  report: AssetPackTileset;
  evidence: string;
  imagePaths: string[];
  collision: boolean;
  terrain: boolean;
  oversizedTileImage: boolean;
}

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "ogg", "m4a", "flac"]);
const FONT_EXTS = new Set(["ttf", "otf", "woff", "woff2"]);
const JSON_TILED_EXTS = new Set(["json", "tmj", "tsj"]);
const PACK_CODE_ORDER = [
  "PACK_LICENSE_UNKNOWN",
  "PACK_FILE_LIMIT_EXCEEDED",
  "PACK_IMAGE_INVALID",
  "PACK_METADATA_INVALID",
  "PACK_METADATA_MISSING",
  "PACK_VISUAL_REVIEW_REQUIRED",
  "PACK_ISOMETRIC_UNSUPPORTED",
  "PACK_ORIENTATION_UNSUPPORTED",
  "PACK_TILE_FLIPS_UNSUPPORTED",
  "PACK_OBJECT_LAYER_UNSUPPORTED",
  "PACK_TILE_OFFSET_UNSUPPORTED",
  "PACK_MIXED_TILE_SIZE",
  "PACK_OVERSIZED_TILE",
  "PACK_COLLISION_NOT_IMPORTED",
  "PACK_TERRAIN_RULES_NOT_IMPORTED",
];

function extension(path: string): string {
  return path.slice(path.lastIndexOf(".") + 1).toLowerCase();
}

function classify(path: string): AssetPackFileKind {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const ext = extension(name);
  if (/^(licen[cs]e|copying|copyright)([._-]|$)/.test(name)) return "license";
  if (/^readme([._-]|$)/.test(name)) return "readme";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (AUDIO_EXTS.has(ext)) return "audio";
  if (FONT_EXTS.has(ext)) return "font";
  if (ext === "tmx" || ext === "tmj") return "map";
  if (ext === "tsx" || ext === "tsj") return "tileset";
  if (ext === "json" || ext === "xml" || ext === "txt" || ext === "md")
    return "metadata";
  return "other";
}

function numberAttr(element: Element, name: string): number | undefined {
  const raw = element.getAttribute(name);
  if (raw === null || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function stringAttr(element: Element, name: string): string | undefined {
  const value = element.getAttribute(name);
  return value === null || value === "" ? undefined : value;
}

function resolveReference(ownerPath: string, source: string): string | null {
  const normalized = source.replace(/\\/g, "/");
  if (/^(?:[a-z]+:|\/)/i.test(normalized)) return null;
  const resolved = joinPath(dirnamePath(ownerPath), normalized);
  return resolved === ".." || resolved.startsWith("../")
    ? null
    : resolved.replace(/^\.\//, "");
}

function directChildren(parent: Element, names: Set<string>): Element[] {
  const out: Element[] = [];
  for (let node = parent.firstChild; node; node = node.nextSibling) {
    if (node.nodeType === 1 && names.has(node.nodeName))
      out.push(node as Element);
  }
  return out;
}

function xmlDocument(
  text: string,
  DOMParser: DOMParserConstructor,
): Document | null {
  if (/<!DOCTYPE/i.test(text)) return null;
  let invalid = false;
  const document = new DOMParser({
    errorHandler: {
      warning: () => {
        invalid = true;
      },
      error: () => {
        invalid = true;
      },
      fatalError: () => {
        invalid = true;
      },
    },
  }).parseFromString(text, "application/xml");
  return invalid || document.documentElement.nodeName === "parsererror"
    ? null
    : document;
}

function collectXmlLayers(parent: Element, out: AssetPackLayer[]): void {
  for (const element of directChildren(
    parent,
    new Set(["layer", "objectgroup", "imagelayer", "group"]),
  )) {
    const layer: AssetPackLayer = {
      name: stringAttr(element, "name") ?? "",
      type: element.nodeName,
    };
    const visible = numberAttr(element, "visible");
    const opacity = numberAttr(element, "opacity");
    const offsetX = numberAttr(element, "offsetx");
    const offsetY = numberAttr(element, "offsety");
    if (visible !== undefined) layer.visible = visible !== 0;
    if (opacity !== undefined) layer.opacity = opacity;
    if (offsetX !== undefined) layer.offsetX = offsetX;
    if (offsetY !== undefined) layer.offsetY = offsetY;
    out.push(layer);
    if (element.nodeName === "group") collectXmlLayers(element, out);
  }
}

function hasXmlFlippedGid(map: Element): boolean {
  for (const data of Array.from(map.getElementsByTagName("data"))) {
    if ((data.getAttribute("encoding") ?? "") === "csv") {
      for (const raw of (data.textContent ?? "").split(/[\s,]+/)) {
        if (raw && ((Number(raw) >>> 0) & TILED_GID_FLAGS) !== 0) return true;
      }
    }
  }
  for (const tile of Array.from(map.getElementsByTagName("tile"))) {
    const gid = numberAttr(tile, "gid");
    if (gid !== undefined && ((gid >>> 0) & TILED_GID_FLAGS) !== 0) return true;
  }
  return false;
}

function jsonNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function jsonString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function jsonLayers(
  value: unknown,
  out: AssetPackLayer[] = [],
): AssetPackLayer[] {
  if (!Array.isArray(value)) return out;
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const layer = raw as Record<string, unknown>;
    out.push({
      name: jsonString(layer.name) ?? "",
      type: jsonString(layer.type) ?? "unknown",
      ...(typeof layer.visible === "boolean" ? { visible: layer.visible } : {}),
      ...(jsonNumber(layer.opacity) !== undefined
        ? { opacity: jsonNumber(layer.opacity) }
        : {}),
      ...(jsonNumber(layer.offsetx) !== undefined
        ? { offsetX: jsonNumber(layer.offsetx) }
        : {}),
      ...(jsonNumber(layer.offsety) !== undefined
        ? { offsetY: jsonNumber(layer.offsety) }
        : {}),
    });
    if (layer.type === "group") jsonLayers(layer.layers, out);
  }
  return out;
}

function jsonHasFlippedGid(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const layer = raw as Record<string, unknown>;
    const arrays = [
      Array.isArray(layer.data) ? layer.data : [],
      ...(Array.isArray(layer.chunks)
        ? layer.chunks.map((chunk) =>
            chunk &&
            typeof chunk === "object" &&
            Array.isArray((chunk as Record<string, unknown>).data)
              ? ((chunk as Record<string, unknown>).data as unknown[])
              : [],
          )
        : []),
    ];
    if (
      arrays.some((data) =>
        data.some(
          (gid) =>
            typeof gid === "number" && ((gid >>> 0) & TILED_GID_FLAGS) !== 0,
        ),
      )
    )
      return true;
    if (layer.type === "group" && jsonHasFlippedGid(layer.layers)) return true;
  }
  return false;
}

function addReferencedBy(
  refs: Map<string, Set<string>>,
  imagePath: string | null,
  ownerPath: string,
): void {
  if (!imagePath) return;
  const owners = refs.get(imagePath) ?? new Set<string>();
  owners.add(ownerPath);
  refs.set(imagePath, owners);
}

function collectJsonLayerImageRefs(
  value: unknown,
  ownerPath: string,
  refs: Map<string, Set<string>>,
): void {
  if (!Array.isArray(value)) return;
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const layer = raw as Record<string, unknown>;
    const source = jsonString(layer.image);
    if (source)
      addReferencedBy(refs, resolveReference(ownerPath, source), ownerPath);
    collectJsonLayerImageRefs(layer.layers, ownerPath, refs);
  }
}

function parseXmlTileset(
  root: Element,
  ownerPath: string,
  firstGid: number | undefined,
  source: string | undefined,
  refs: Map<string, Set<string>>,
): TilesetFacts {
  const tileOffset = root.getElementsByTagName("tileoffset")[0];
  const wangSetCount = root.getElementsByTagName("wangset").length;
  const imagePaths: string[] = [];
  for (const image of Array.from(root.getElementsByTagName("image"))) {
    const imageSource = stringAttr(image, "source");
    if (!imageSource) continue;
    const resolved = resolveReference(ownerPath, imageSource);
    if (resolved) {
      imagePaths.push(resolved);
      addReferencedBy(refs, resolved, ownerPath);
    }
  }
  const tileWidth = numberAttr(root, "tilewidth");
  const tileHeight = numberAttr(root, "tileheight");
  let oversizedTileImage = false;
  for (const tile of Array.from(root.getElementsByTagName("tile"))) {
    const image = directChildren(tile, new Set(["image"]))[0];
    if (!image) continue;
    const width = numberAttr(image, "width");
    const height = numberAttr(image, "height");
    if (
      (width !== undefined && tileWidth !== undefined && width > tileWidth) ||
      (height !== undefined && tileHeight !== undefined && height > tileHeight)
    ) {
      oversizedTileImage = true;
    }
  }
  return {
    report: {
      ...(firstGid !== undefined ? { firstGid } : {}),
      ...(source ? { source } : {}),
      ...(tileWidth !== undefined ? { tileWidth } : {}),
      ...(tileHeight !== undefined ? { tileHeight } : {}),
      ...(numberAttr(root, "columns") !== undefined
        ? { columns: numberAttr(root, "columns") }
        : {}),
      ...(numberAttr(root, "margin") !== undefined
        ? { margin: numberAttr(root, "margin") }
        : {}),
      ...(numberAttr(root, "spacing") !== undefined
        ? { spacing: numberAttr(root, "spacing") }
        : {}),
      ...(tileOffset
        ? {
            tileOffset: {
              x: numberAttr(tileOffset, "x") ?? 0,
              y: numberAttr(tileOffset, "y") ?? 0,
            },
          }
        : {}),
      ...(stringAttr(root, "objectalignment")
        ? { objectAlignment: stringAttr(root, "objectalignment") }
        : {}),
      ...(wangSetCount > 0 ? { wangSetCount } : {}),
    },
    evidence: ownerPath,
    imagePaths,
    collision: Array.from(root.getElementsByTagName("tile")).some(
      (tile) => tile.getElementsByTagName("objectgroup").length > 0,
    ),
    terrain:
      wangSetCount > 0 || root.getElementsByTagName("terrain").length > 0,
    oversizedTileImage,
  };
}

function parseJsonTileset(
  raw: Record<string, unknown>,
  ownerPath: string,
  firstGid: number | undefined,
  source: string | undefined,
  refs: Map<string, Set<string>>,
): TilesetFacts {
  const offset =
    raw.tileoffset && typeof raw.tileoffset === "object"
      ? (raw.tileoffset as Record<string, unknown>)
      : undefined;
  const imagePaths: string[] = [];
  const addImage = (sourceValue: unknown) => {
    const imageSource = jsonString(sourceValue);
    if (!imageSource) return;
    const resolved = resolveReference(ownerPath, imageSource);
    if (resolved) {
      imagePaths.push(resolved);
      addReferencedBy(refs, resolved, ownerPath);
    }
  };
  addImage(raw.image);
  const tiles = Array.isArray(raw.tiles) ? raw.tiles : [];
  for (const tile of tiles) {
    if (tile && typeof tile === "object")
      addImage((tile as Record<string, unknown>).image);
  }
  const tileWidth = jsonNumber(raw.tilewidth);
  const tileHeight = jsonNumber(raw.tileheight);
  const oversizedTileImage = tiles.some((tile) => {
    if (!tile || typeof tile !== "object") return false;
    const value = tile as Record<string, unknown>;
    const width = jsonNumber(value.imagewidth);
    const height = jsonNumber(value.imageheight);
    return (
      (width !== undefined && tileWidth !== undefined && width > tileWidth) ||
      (height !== undefined && tileHeight !== undefined && height > tileHeight)
    );
  });
  const wangSetCount = Array.isArray(raw.wangsets) ? raw.wangsets.length : 0;
  return {
    report: {
      ...(firstGid !== undefined ? { firstGid } : {}),
      ...(source ? { source } : {}),
      ...(tileWidth !== undefined ? { tileWidth } : {}),
      ...(tileHeight !== undefined ? { tileHeight } : {}),
      ...(jsonNumber(raw.columns) !== undefined
        ? { columns: jsonNumber(raw.columns) }
        : {}),
      ...(jsonNumber(raw.margin) !== undefined
        ? { margin: jsonNumber(raw.margin) }
        : {}),
      ...(jsonNumber(raw.spacing) !== undefined
        ? { spacing: jsonNumber(raw.spacing) }
        : {}),
      ...(offset
        ? {
            tileOffset: {
              x: jsonNumber(offset.x) ?? 0,
              y: jsonNumber(offset.y) ?? 0,
            },
          }
        : {}),
      ...(jsonString(raw.objectalignment)
        ? { objectAlignment: jsonString(raw.objectalignment) }
        : {}),
      ...(wangSetCount > 0 ? { wangSetCount } : {}),
    },
    evidence: ownerPath,
    imagePaths,
    collision: tiles.some(
      (tile) =>
        !!tile &&
        typeof tile === "object" &&
        !!(tile as Record<string, unknown>).objectgroup,
    ),
    terrain:
      wangSetCount > 0 ||
      (Array.isArray(raw.terrains) && raw.terrains.length > 0),
    oversizedTileImage,
  };
}

export async function inspectAssetPack(
  fs: FsLike,
  params: PackParams,
): Promise<AssetPackReport> {
  // Keep the Node-only XML parser out of Hearth's standalone browser player.
  // The player bundles @hearth/core's registry, but never invokes inspection.
  const { DOMParser } = await import("@xmldom/xmldom");
  if (!(await fs.exists(params.path)))
    throw new Error(`Asset pack path not found: ${params.path}`);
  if (!(await fs.stat(params.path)).isDirectory) {
    throw new Error(`Asset pack path is not a directory: ${params.path}`);
  }

  const root = fs.realpath ? await fs.realpath(params.path) : params.path;
  const canonicalPrefix = root.endsWith("/") ? root : `${root}/`;
  const diskPaths = new Map<string, string>();
  const seenDirs = new Set<string>();
  let visitedEntries = 0;

  const walk = async (
    diskPath: string,
    relativePath: string,
  ): Promise<void> => {
    const canonical = fs.realpath ? await fs.realpath(diskPath) : diskPath;
    if (canonical !== root && !canonical.startsWith(canonicalPrefix)) return;
    if (seenDirs.has(canonical)) return;
    seenDirs.add(canonical);
    for (const name of (await fs.readdir(diskPath)).sort()) {
      visitedEntries++;
      if (visitedEntries > ASSET_PACK_MAX_ENTRIES) {
        throw new Error(`Asset pack exceeds ${ASSET_PACK_MAX_ENTRIES} entries`);
      }
      const childDisk = joinPath(diskPath, name);
      const childRelative = relativePath ? joinPath(relativePath, name) : name;
      const childCanonical = fs.realpath
        ? await fs.realpath(childDisk)
        : childDisk;
      if (
        childCanonical !== root &&
        !childCanonical.startsWith(canonicalPrefix)
      )
        continue;
      const stat = await fs.stat(childDisk);
      if (stat.isDirectory) {
        await walk(childDisk, childRelative);
      } else {
        if (diskPaths.size >= ASSET_PACK_MAX_FILES) {
          throw new Error(`Asset pack exceeds ${ASSET_PACK_MAX_FILES} files`);
        }
        diskPaths.set(childRelative, childDisk);
      }
    }
  };
  await walk(params.path, "");

  const paths = [...diskPaths.keys()].sort();
  const files = paths.map((path) => ({ path, kind: classify(path) }));
  const contents = new Map<string, string>();
  const imageRefs = new Map<string, Set<string>>();
  const images: AssetPackImage[] = [];
  const reviewImages: string[] = [];
  const fileLimitEvidence = new Set<string>();
  const invalidImageEvidence = new Set<string>();
  let readBytes = 0;
  for (const path of paths) {
    const diskPath = diskPaths.get(path)!;
    const stat = await fs.stat(diskPath);
    const kind = classify(path);
    const inspectable =
      kind === "image" ||
      extension(path) === "tmx" ||
      extension(path) === "tsx" ||
      JSON_TILED_EXTS.has(extension(path));
    const canRead =
      stat.size <= ASSET_PACK_MAX_FILE_BYTES &&
      readBytes + stat.size <= ASSET_PACK_MAX_READ_BYTES;
    if (inspectable && !canRead) fileLimitEvidence.add(path);
    if (kind === "image") {
      const info = canRead
        ? probeImage(await fs.readFileBinary(diskPath))
        : null;
      if (canRead) readBytes += stat.size;
      if (canRead && !info) invalidImageEvidence.add(path);
      images.push({
        path,
        ...(info
          ? { width: info.width, height: info.height, format: info.format }
          : {}),
        referencedBy: [],
      });
      if (info) reviewImages.push(path);
    } else if (
      canRead &&
      (extension(path) === "tmx" ||
        extension(path) === "tsx" ||
        JSON_TILED_EXTS.has(extension(path)))
    ) {
      contents.set(path, await fs.readFile(diskPath));
      readBytes += stat.size;
    }
  }

  const diagnostics = new Map<string, AssetPackDiagnostic>();
  const invalidMetadata = new Set<string>();
  const addDiagnostic = (
    code: string,
    severity: AssetPackDiagnostic["severity"],
    message: string,
    evidence: string[],
    suggestion?: string,
  ) => {
    const existing = diagnostics.get(code);
    if (existing) {
      existing.evidence = [
        ...new Set([...existing.evidence, ...evidence]),
      ].sort();
      return;
    }
    diagnostics.set(code, {
      code,
      severity,
      message,
      evidence: [...new Set(evidence)].sort(),
      ...(suggestion ? { suggestion } : {}),
    });
  };
  if (fileLimitEvidence.size > 0) {
    addDiagnostic(
      "PACK_FILE_LIMIT_EXCEEDED",
      "warning",
      "Some files exceeded the per-file or aggregate inspection read limit.",
      [...fileLimitEvidence],
      "Inspect these files separately before relying on this report or importing them.",
    );
  }
  if (invalidImageEvidence.size > 0) {
    addDiagnostic(
      "PACK_IMAGE_INVALID",
      "warning",
      "Some files use an image extension but have unreadable image headers or dimensions.",
      [...invalidImageEvidence],
      "Replace or repair these images before import or visual review.",
    );
  }

  const parsedTilesets = new Map<string, TilesetFacts>();
  const parseTilesetFile = (path: string): TilesetFacts | null => {
    const cached = parsedTilesets.get(path);
    if (cached) return cached;
    const text = contents.get(path);
    if (text === undefined) return null;
    let facts: TilesetFacts | null = null;
    if (extension(path) === "tsx") {
      const document = xmlDocument(text, DOMParser);
      if (document?.documentElement.nodeName === "tileset") {
        facts = parseXmlTileset(
          document.documentElement,
          path,
          undefined,
          undefined,
          imageRefs,
        );
      } else invalidMetadata.add(path);
    } else if (JSON_TILED_EXTS.has(extension(path))) {
      try {
        const value = JSON.parse(text);
        if (
          value &&
          typeof value === "object" &&
          ((value as Record<string, unknown>).type === "tileset" ||
            ("tilewidth" in (value as Record<string, unknown>) &&
              !("layers" in (value as Record<string, unknown>))))
        ) {
          facts = parseJsonTileset(
            value as Record<string, unknown>,
            path,
            undefined,
            undefined,
            imageRefs,
          );
        }
      } catch {
        invalidMetadata.add(path);
        return null;
      }
    }
    if (facts) {
      parsedTilesets.set(path, facts);
      const file = files.find((item) => item.path === path);
      if (file) file.kind = "tileset";
    }
    return facts;
  };

  for (const file of files) {
    if (file.kind === "tileset" || extension(file.path) === "json") {
      parseTilesetFile(file.path);
    }
  }

  const maps: AssetPackMap[] = [];
  const mapTilesetFacts: Array<{ map: AssetPackMap; facts: TilesetFacts }> = [];
  for (const path of paths) {
    const text = contents.get(path);
    if (text === undefined) continue;
    if (extension(path) === "tmx") {
      const document = xmlDocument(text, DOMParser);
      const rootElement = document?.documentElement;
      if (!rootElement || rootElement.nodeName !== "map") {
        invalidMetadata.add(path);
        continue;
      }
      const map: AssetPackMap = {
        path,
        format: "tmx",
        ...(stringAttr(rootElement, "orientation")
          ? { orientation: stringAttr(rootElement, "orientation") }
          : {}),
        ...(numberAttr(rootElement, "tilewidth") !== undefined
          ? { tileWidth: numberAttr(rootElement, "tilewidth") }
          : {}),
        ...(numberAttr(rootElement, "tileheight") !== undefined
          ? { tileHeight: numberAttr(rootElement, "tileheight") }
          : {}),
        ...(numberAttr(rootElement, "width") !== undefined
          ? { width: numberAttr(rootElement, "width") }
          : {}),
        ...(numberAttr(rootElement, "height") !== undefined
          ? { height: numberAttr(rootElement, "height") }
          : {}),
        layers: [],
        tilesets: [],
        features: [],
      };
      collectXmlLayers(rootElement, map.layers);
      for (const imageLayer of Array.from(
        rootElement.getElementsByTagName("imagelayer"),
      )) {
        const image = directChildren(imageLayer, new Set(["image"]))[0];
        const source = image && stringAttr(image, "source");
        if (source)
          addReferencedBy(imageRefs, resolveReference(path, source), path);
      }
      for (const tileset of directChildren(rootElement, new Set(["tileset"]))) {
        const firstGid = numberAttr(tileset, "firstgid");
        const source = stringAttr(tileset, "source");
        let facts: TilesetFacts | null;
        if (source) {
          const resolved = resolveReference(path, source);
          const external = resolved ? parseTilesetFile(resolved) : null;
          facts = external
            ? {
                ...external,
                report: {
                  ...external.report,
                  ...(firstGid !== undefined ? { firstGid } : {}),
                  source,
                },
              }
            : null;
        } else {
          facts = parseXmlTileset(
            tileset,
            path,
            firstGid,
            undefined,
            imageRefs,
          );
        }
        if (facts) {
          map.tilesets.push(facts.report);
          mapTilesetFacts.push({ map, facts });
        } else if (source) {
          const evidenceSource = resolveReference(path, source) ?? source;
          map.tilesets.push({
            ...(firstGid !== undefined ? { firstGid } : {}),
            source,
          });
          addDiagnostic(
            "PACK_METADATA_MISSING",
            "warning",
            "Referenced Tiled tileset metadata could not be read.",
            [path, evidenceSource],
          );
        }
      }
      if (hasXmlFlippedGid(rootElement)) map.features.push("tile-flips");
      maps.push(map);
      continue;
    }
    if (!JSON_TILED_EXTS.has(extension(path))) continue;
    let raw: Record<string, unknown>;
    try {
      const value = JSON.parse(text);
      if (!value || typeof value !== "object") continue;
      raw = value as Record<string, unknown>;
    } catch {
      invalidMetadata.add(path);
      continue;
    }
    if (raw.type !== "map" && !Array.isArray(raw.layers)) continue;
    const map: AssetPackMap = {
      path,
      format: "tiled-json",
      ...(jsonString(raw.orientation)
        ? { orientation: jsonString(raw.orientation) }
        : {}),
      ...(jsonNumber(raw.tilewidth) !== undefined
        ? { tileWidth: jsonNumber(raw.tilewidth) }
        : {}),
      ...(jsonNumber(raw.tileheight) !== undefined
        ? { tileHeight: jsonNumber(raw.tileheight) }
        : {}),
      ...(jsonNumber(raw.width) !== undefined
        ? { width: jsonNumber(raw.width) }
        : {}),
      ...(jsonNumber(raw.height) !== undefined
        ? { height: jsonNumber(raw.height) }
        : {}),
      layers: jsonLayers(raw.layers),
      tilesets: [],
      features: [],
    };
    collectJsonLayerImageRefs(raw.layers, path, imageRefs);
    for (const entry of Array.isArray(raw.tilesets) ? raw.tilesets : []) {
      if (!entry || typeof entry !== "object") continue;
      const tileset = entry as Record<string, unknown>;
      const firstGid = jsonNumber(tileset.firstgid);
      const source = jsonString(tileset.source);
      let facts: TilesetFacts | null;
      if (source) {
        const resolved = resolveReference(path, source);
        const external = resolved ? parseTilesetFile(resolved) : null;
        facts = external
          ? {
              ...external,
              report: {
                ...external.report,
                ...(firstGid !== undefined ? { firstGid } : {}),
                source,
              },
            }
          : null;
      } else {
        facts = parseJsonTileset(tileset, path, firstGid, undefined, imageRefs);
      }
      if (facts) {
        map.tilesets.push(facts.report);
        mapTilesetFacts.push({ map, facts });
      } else if (source) {
        const evidenceSource = resolveReference(path, source) ?? source;
        map.tilesets.push({
          ...(firstGid !== undefined ? { firstGid } : {}),
          source,
        });
        addDiagnostic(
          "PACK_METADATA_MISSING",
          "warning",
          "Referenced Tiled tileset metadata could not be read.",
          [path, evidenceSource],
        );
      }
    }
    if (jsonHasFlippedGid(raw.layers)) map.features.push("tile-flips");
    maps.push(map);
    const file = files.find((item) => item.path === path);
    if (file) file.kind = "map";
  }

  const allTilesets = [
    ...parsedTilesets.values(),
    ...mapTilesetFacts
      .filter(({ facts }) => !parsedTilesets.has(facts.evidence))
      .map(({ facts }) => facts),
  ];
  for (const map of maps) {
    const evidence = [map.path];
    if (map.orientation === "isometric") {
      addDiagnostic(
        "PACK_ISOMETRIC_UNSUPPORTED",
        "error",
        "Hearth Tilemaps do not support isometric map orientation.",
        evidence,
        "Use authored art as positioned sprites/layers, or choose an orthogonal pack.",
      );
    } else if (map.orientation && map.orientation !== "orthogonal") {
      addDiagnostic(
        "PACK_ORIENTATION_UNSUPPORTED",
        "error",
        `Hearth Tilemaps do not support "${map.orientation}" map orientation.`,
        evidence,
      );
    }
    if (map.features.includes("tile-flips")) {
      addDiagnostic(
        "PACK_TILE_FLIPS_UNSUPPORTED",
        "warning",
        "The pack uses Tiled GID transform flags that Hearth does not import.",
        evidence,
      );
    }
    if (map.layers.some((layer) => layer.type === "objectgroup")) {
      addDiagnostic(
        "PACK_OBJECT_LAYER_UNSUPPORTED",
        "warning",
        "Tiled object layers require manual representation in Hearth.",
        evidence,
      );
    }
  }
  for (const { map, facts } of mapTilesetFacts) {
    const evidence = [facts.evidence, map.path];
    const tileWidth = facts.report.tileWidth;
    const tileHeight = facts.report.tileHeight;
    if (
      facts.report.tileOffset &&
      (facts.report.tileOffset.x !== 0 || facts.report.tileOffset.y !== 0)
    ) {
      addDiagnostic(
        "PACK_TILE_OFFSET_UNSUPPORTED",
        "warning",
        "Tileset tile offsets require manual placement in Hearth.",
        evidence,
      );
    }
    if (
      (map.tileWidth !== undefined &&
        tileWidth !== undefined &&
        map.tileWidth !== tileWidth) ||
      (map.tileHeight !== undefined &&
        tileHeight !== undefined &&
        map.tileHeight !== tileHeight)
    ) {
      addDiagnostic(
        "PACK_MIXED_TILE_SIZE",
        "warning",
        "Map cell size and tileset tile size differ.",
        evidence,
      );
    }
    if (
      facts.oversizedTileImage ||
      (map.tileWidth !== undefined &&
        tileWidth !== undefined &&
        tileWidth > map.tileWidth) ||
      (map.tileHeight !== undefined &&
        tileHeight !== undefined &&
        tileHeight > map.tileHeight)
    ) {
      addDiagnostic(
        "PACK_OVERSIZED_TILE",
        "warning",
        "Some tile art is larger than its map cell and needs bottom-aligned sprite placement.",
        evidence,
      );
    }
  }
  if (allTilesets.some((facts) => facts.collision)) {
    addDiagnostic(
      "PACK_COLLISION_NOT_IMPORTED",
      "warning",
      "Embedded Tiled collision objects are not imported by Hearth.",
      allTilesets.filter((f) => f.collision).map((f) => f.evidence),
    );
  }
  if (allTilesets.some((facts) => facts.terrain)) {
    addDiagnostic(
      "PACK_TERRAIN_RULES_NOT_IMPORTED",
      "warning",
      "Tiled terrain and Wang rules are not imported by Hearth.",
      allTilesets.filter((f) => f.terrain).map((f) => f.evidence),
    );
  }
  const distinctTileSizes = new Set(
    allTilesets
      .filter(
        (facts) =>
          facts.report.tileWidth !== undefined &&
          facts.report.tileHeight !== undefined,
      )
      .map((facts) => `${facts.report.tileWidth}x${facts.report.tileHeight}`),
  );
  if (distinctTileSizes.size > 1) {
    addDiagnostic(
      "PACK_MIXED_TILE_SIZE",
      "warning",
      "The pack declares multiple tileset tile sizes.",
      allTilesets.map((facts) => facts.evidence),
    );
  }
  for (const facts of allTilesets) {
    if (
      facts.report.tileOffset &&
      (facts.report.tileOffset.x !== 0 || facts.report.tileOffset.y !== 0)
    ) {
      addDiagnostic(
        "PACK_TILE_OFFSET_UNSUPPORTED",
        "warning",
        "Tileset tile offsets require manual placement in Hearth.",
        [facts.evidence],
      );
    }
    if (facts.oversizedTileImage) {
      addDiagnostic(
        "PACK_OVERSIZED_TILE",
        "warning",
        "Some tile art is larger than its tileset cell and needs bottom-aligned sprite placement.",
        [facts.evidence],
      );
    }
  }

  const evidenceFiles = files
    .filter((file) => file.kind === "license" || file.kind === "readme")
    .map((file) => file.path);
  if (!params.license) {
    addDiagnostic(
      "PACK_LICENSE_UNKNOWN",
      "warning",
      "No exact license was supplied for this pack.",
      evidenceFiles,
      "Verify the listing and license text before importing any asset.",
    );
  }
  if (maps.length === 0 && parsedTilesets.size === 0) {
    addDiagnostic(
      "PACK_METADATA_MISSING",
      "warning",
      "No readable Tiled map or tileset metadata was found.",
      [],
      "Treat visual tile roles and adjacency as inferred until proven in a test scene.",
    );
  }
  if (invalidMetadata.size > 0) {
    addDiagnostic(
      "PACK_METADATA_INVALID",
      "warning",
      "Some Tiled metadata could not be parsed.",
      [...invalidMetadata],
      "Repair or replace the listed metadata before relying on its layout or tile roles.",
    );
  }
  addDiagnostic(
    "PACK_VISUAL_REVIEW_REQUIRED",
    "info",
    "Machine metadata cannot establish visual roles, anchors, palette cohesion, or seams.",
    images.map((image) => image.path),
    "Review the ordered images with vision before importing or placing them.",
  );

  for (const image of images) {
    image.referencedBy = [...(imageRefs.get(image.path) ?? [])].sort();
  }
  for (const map of maps) {
    const features = new Set(map.features);
    if (map.layers.some((layer) => layer.type === "objectgroup"))
      features.add("object-layers");
    if (map.tilesets.some((tileset) => tileset.tileOffset))
      features.add("tile-offset");
    map.features = [...features].sort();
  }
  const orderedDiagnostics = [...diagnostics.values()].sort(
    (a, b) => PACK_CODE_ORDER.indexOf(a.code) - PACK_CODE_ORDER.indexOf(b.code),
  );
  const status: AssetPackStatus = orderedDiagnostics.some(
    (diagnostic) => diagnostic.severity === "error",
  )
    ? "unsupported"
    : orderedDiagnostics.some((diagnostic) => diagnostic.severity === "warning")
      ? "partial"
      : "compatible";

  return {
    root,
    status,
    provenance: {
      ...(params.sourceUrl ? { sourceUrl: params.sourceUrl } : {}),
      ...(params.author ? { author: params.author } : {}),
      ...(params.license ? { license: params.license } : {}),
      evidenceFiles,
    },
    files,
    images,
    maps,
    diagnostics: orderedDiagnostics,
    reviewImages,
    reviewChecklist: [
      "Compare loose tiles with authored sample maps or screenshots.",
      "Identify floor, wall top, wall face, edges, corners, end caps, props, actors, and animations.",
      "Check seams, tile footprint, bottom/feet anchors, outline weight, palette, pixel density, and light direction.",
      "Prove inferred roles and collision in a small scene at gameplay camera scale.",
    ],
  };
}
