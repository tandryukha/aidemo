# store-demo — native capture + store media smoke test

Drives the iOS **Settings** app (present on every simulator) with Maestro, then
renders an App Store App Preview, a Play promo, a screenshot set and a feature
graphic. Needs Xcode, Maestro, ffmpeg and Chrome — and one booted iPhone
simulator (or pass `--device <name> --boot`).

```bash
node bin/aidemo.mjs store-check       examples/store-demo
node bin/aidemo.mjs native-record     examples/store-demo   # ~1 min
node bin/aidemo.mjs store-video       examples/store-demo   # + --lang ru for the Russian captions
node bin/aidemo.mjs store-screenshots examples/store-demo
```

Outputs land in `examples/store-demo/output/store/` (gitignored with the other
generated folders). Record on an iPhone 6.9" simulator for full-size frames;
any iPhone works for the smoke test.
