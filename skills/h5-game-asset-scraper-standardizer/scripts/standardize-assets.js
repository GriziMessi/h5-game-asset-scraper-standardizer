#!/usr/bin/env node

import sharp from 'sharp';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_CONFIG = path.resolve(__dirname, '../references/asset-spec.json');

function parseArgs(argv) {
  const args = {
    outputDir: argv[0],
    config: DEFAULT_CONFIG,
    roles: {},
    cropTopRoles: new Set()  // roles that should keep the TOP (north crop)
  };

  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === '--config' && value) {
      args.config = path.resolve(value);
      i += 1;
    } else if (arg === '--role' && value) {
      const [role, ...rest] = value.split('=');
      const file = rest.join('=');
      if (role && file) args.roles[role] = file;
      i += 1;
    } else if (arg === '--crop-top' && value) {
      // Comma-separated role names that should anchor to the top (north)
      // instead of the default bottom anchor (south) for 1200x628 outputs.
      // Example: --crop-top "cover,screenshot_3"
      value.split(',').forEach((r) => args.cropTopRoles.add(r.trim()));
      i += 1;
    }
  }

  return args;
}

function usage() {
  console.error(`Usage: node standardize-assets.js <output-dir> [--config ../references/asset-spec.json] [--role icon=raw-images/icon.png]`);
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

function roleType(role) {
  if (role === 'icon') return 'icon';
  if (role === 'cover') return 'cover';
  if (role.startsWith('screenshot_')) return 'screenshot';
  return null;
}

function resolveRolePath(outputDir, filePath) {
  if (path.isAbsolute(filePath)) return filePath;
  return path.resolve(outputDir, filePath);
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findRoleFile(outputDir, role, manifest) {
  const candidates = [
    manifest.suggestedRoles?.[role],
    `raw-images/${role}.png`,
    `raw-images/${role}.jpg`,
    `raw-images/${role}.jpeg`,
    `raw-images/${role}.webp`
  ].filter(Boolean);

  for (const candidate of candidates) {
    const absolute = resolveRolePath(outputDir, candidate);
    if (await fileExists(absolute)) return absolute;
  }
  return null;
}

async function discoverNamedRoles(outputDir) {
  const discovered = {};
  const expected = ['icon', 'cover', 'screenshot_1', 'screenshot_2', 'screenshot_3', 'screenshot_4'];

  for (const role of expected) {
    const roleFile = await findRoleFile(outputDir, role, { suggestedRoles: {} });
    if (roleFile) {
      discovered[role] = path.relative(outputDir, roleFile);
    }
  }

  return discovered;
}

async function standardizeOne(inputFile, outputFile, options, defaults, cropTop) {
  // For landscape banner formats (height ≤ 628, e.g. 1200x628):
  //   - Default: anchor south (keep bottom) — preserves logos, text, CTAs near lower edge
  //   - If cropTop: anchor north (keep top) — for images where key content is near the top
  // All other sizes (icons, 1920x1080 covers) use centre crop.
  let position;
  if (options.height <= 628) {
    position = cropTop ? 'north' : 'south';
  } else {
    position = 'centre';
  }

  await sharp(inputFile)
    .resize({
      width: options.width,
      height: options.height,
      fit: options.fit || 'cover',
      position,
      background: defaults.background || '#000000'
    })
    .png({ compressionLevel: defaults.pngCompressionLevel ?? 9 })
    .toFile(outputFile);

  const metadata = await sharp(outputFile).metadata();
  return {
    file: outputFile,
    width: metadata.width,
    height: metadata.height
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.outputDir) {
    usage();
    process.exit(1);
  }

  const outputDir = path.resolve(args.outputDir);
  const standardizedDir = path.join(outputDir, 'standardized');
  await fs.mkdir(standardizedDir, { recursive: true });

  const manifestPath = path.join(outputDir, 'manifest.json');
  const manifest = await readJson(manifestPath);
  const spec = await readJson(args.config);
  const namedRoles = await discoverNamedRoles(outputDir);

  const inferredRoles = {
    ...manifest.suggestedRoles,
    ...namedRoles,
    ...args.roles
  };

  const outputRecords = [];
  const missingRoles = [];

  for (const role of Object.keys(inferredRoles).sort()) {
    const type = roleType(role);
    if (!type || !spec.roles[type]) continue;

    const inputFile = args.roles[role]
      ? resolveRolePath(outputDir, args.roles[role])
      : await findRoleFile(outputDir, role, manifest);

    if (!inputFile || !(await fileExists(inputFile))) {
      missingRoles.push(role);
      continue;
    }

    for (const output of spec.roles[type].outputs) {
      const outputName = `${role}_${output.suffix}.png`;
      const outputFile = path.join(standardizedDir, outputName);
      const cropTop = args.cropTopRoles.has(role);
      const result = await standardizeOne(inputFile, outputFile, output, spec.defaults || {}, cropTop);
      outputRecords.push({
        role,
        source: path.relative(outputDir, inputFile),
        file: path.relative(outputDir, result.file),
        width: result.width,
        height: result.height
      });
    }
  }

  const nextManifest = {
    ...manifest,
    standardizedAt: new Date().toISOString(),
    outputs: outputRecords,
    missingRoles
  };
  await fs.writeFile(manifestPath, JSON.stringify(nextManifest, null, 2), 'utf8');
  console.log(JSON.stringify({ outputs: outputRecords, missingRoles }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
