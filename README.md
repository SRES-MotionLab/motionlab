# MotionLab (web version)

A free web app for 2D movement analysis: joint angles and projectile motion from video. It works in Safari and Chrome on iPhone, iPad, Android, Chromebook, Windows and Mac. There is nothing to install from an app store.

- **To put it online for students**, follow the step-by-step guide Claude sent with this folder (GitHub Pages, free). Upload *everything* in this folder, keeping the folders as they are.
- **Videos and results stay on each student's own device**, in the browser. Nothing is uploaded and no accounts are needed.
- It must be opened from a website address (https://…). Double-clicking `index.html` on your computer won't work.

## What's in this folder

| Item | What it is |
|---|---|
| `index.html`, `styles.css`, `js/` | The app |
| `icons/`, `manifest.webmanifest` | The home-screen icon and app details |
| `sw.js` | Lets the app open without internet once it has been visited |
| `vendor/` | Google MediaPipe pose model (Apache 2.0 licence) used for automatic joint tracking, about 35 MB |

## Updating

When you get a new version, upload the changed files over the old ones in the same places. Students get the update the next time they open the app with an internet connection.
