# Output Spec

Use this reference when checking or modifying the webpage asset workflow.

## Required Files

- `manifest.json`: structured extraction result with source URL, metadata, text, image records, video records, and standardized output records.
- `description.txt`: human-readable page text in the original language.
- `media/image-urls.txt`: detected image URLs, one per line.
- `media/video-urls.txt`: detected video URLs, one per line.
- `raw-images/`: downloaded source images.
- `standardized/`: final PNG assets.

## Naming

Use these output names:

- `icon_512x512.png`
- `icon_84x84.png`
- `cover_1920x1080.png`
- `cover_1200x628.png`
- `screenshot_1_1920x1080.png`
- `screenshot_1_1200x628.png`
- `screenshot_2_1920x1080.png`
- `screenshot_2_1200x628.png`
- Continue the same pattern for additional screenshots.

## Role Overrides

`standardize-assets.js` accepts explicit role mappings:

```bash
node standardize-assets.js ./outputs/game \
  --role icon=raw-images/my-icon.png \
  --role cover=raw-images/hero.png \
  --role screenshot_1=raw-images/gameplay-1.png
```

Role paths may be absolute or relative to the output directory.

## Quality Rules

- Outputs must be PNG.
- Outputs must exactly match configured dimensions.
- Use crop-to-cover for store images unless the user asks for padding.
- Prefer gameplay/store visuals over decorative web UI fragments.
- Do not invent missing video URLs; leave `video-urls.txt` empty when none are found.
