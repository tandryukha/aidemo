# Recipe: an App Store App Preview + Play promo + screenshots from Maestro flows

Goal: a 15–30 s muted App Preview whose first frame already says what the app
does, the same edit for Google Play, and a screenshot set — all from the
Maestro flows you already have for UI tests. Full reference:
`aidemo guide --topic store`.

## 1. Lay out the project

```
demos/store/
  generated/store.json
  flows/reset.yaml      # unfilmed: seed data, land on the start screen
  flows/voice.yaml      # filmed: one beat per scene
  flows/photo.yaml
  flows/fix.yaml
  brand/icon.png
```

## 2. One scene = one beat = one caption

```json
{
  "title": "MyApp App Preview",
  "device": { "platform": "ios", "id": "iPhone 17 Pro Max", "appId": "com.example.myapp" },
  "env": { "LOCALE": "en" },
  "setup": "flows/reset.yaml",
  "scenes": [
    { "id": "voice", "flow": "flows/voice.yaml", "caption": "Say it. *It's logged.*",
      "ramps": [{ "label": "typing", "rate": 6 }], "holds": [{ "label": "receipt", "afterMs": 1000 }],
      "still": "01-voice" },
    { "id": "photo", "flow": "flows/photo.yaml", "caption": "Or *snap* it.",
      "ramps": [{ "command": "waitForAnimationToEnd" }], "still": "02-photo" },
    { "id": "fix", "flow": "flows/fix.yaml", "caption": "Every number, *one tap* to fix.",
      "tailHoldMs": 700, "still": "03-fix" }
  ],
  "video": { "presets": ["app-store-preview", "play-promo-portrait"] },
  "endCard": { "appName": "MyApp", "icon": "brand/icon.png", "line": "Free on the App Store" },
  "brand": { "background": "#0d1b2a", "accent": "#7ee08a", "fontFile": "brand/Inter-Bold.ttf" },
  "screenshots": {
    "presets": ["ios-6.9", "play-phone"],
    "shots": [
      { "id": "voice", "still": "01-voice", "headline": "Say it. *Logged.*" },
      { "id": "photo", "still": "02-photo", "headline": "Snap a *plate*" },
      { "id": "fix", "still": "03-fix", "headline": "One tap to *fix*" }
    ],
    "featureGraphic": { "headline": "Log food by *voice*", "still": "01-voice" }
  }
}
```

Label the steps the edit should know about:

```yaml
appId: com.example.myapp
---
- tapOn: { id: "mic" }
- inputText:
    text: "two eggs on toast and a flat white"
    label: typing            # ramped 6x
- assertVisible:
    id: "receipt"
    label: receipt           # held 1 s after it lands
```

## 3. Record, edit, check

```bash
aidemo store-check demos/store
aidemo native-record demos/store            # uses the booted simulator; --boot starts (and stops) one
aidemo store-video demos/store              # fails loudly on any store-spec or still-frame violation
aidemo store-screenshots demos/store
aidemo frames demos/store --every 1         # (or open output/store/*.mp4) — look before you upload
```

Re-record one beat: `aidemo native-record demos/store --only photo`. Change a
caption, ramp, hold or preset: rerun `store-video` only.

## 4. Another language

Add `"localized": { "de": { "caption": "…" } }` to each scene (and
`endCard.localized`, `shots[].localized`), then:

```bash
aidemo store-video demos/store --lang de          # → output/store/app-store-preview.de.mp4
aidemo store-screenshots demos/store --lang de
```

The UI in the clips stays in the language it was recorded in — record a
separate project (e.g. `env: {LOCALE: "de"}` + its own flows) when the UI must
be localized too.

## 5. Upload

- **App Store Connect**: `output/store/app-store-preview.mp4` into the iPhone
  6.9" App Preview slot; set the poster frame to `posterTimeCode` from
  `app-store-preview.report.json`.
- **Google Play**: upload `play-promo-portrait.mp4` to YouTube (public or
  unlisted, ads off), paste the URL in Play Console → Main store listing;
  screenshots from `screenshots/play-phone/`, feature graphic from
  `screenshots/play-feature-graphic/`.
