# Gradebook

A small web app for recording and showing grades in a tutoring business.

- **Admin (you):** add/remove classes, add/remove students (each gets their own login), create assignments (Test or Worksheet) for one or more classes, type in scores, and see stats for each assignment broken down by class.
- **Students:** log in and see their average in every class they're in. Clicking a class opens a popup with every assignment grade. Test corrections appear in their own highlighted box, separate from the original score.

## How grades are calculated

- Assignment grade = **A ÷ T** (acquired points ÷ total points).
- Class average = **sum of all A ÷ sum of all T** for graded assignments in that class. Nothing else is weighted.
- Assignments with no score entered are left out until you grade them.
- **Test correction points** are stored separately from the test score. Students always see the original score, with corrections shown in their own box.
  By default, corrections **do** count toward the class average (A + corrections). You can turn this off in **Settings**.
- Score + corrections can't add up to more than T.

## Hosting on Netlify (free plan)

The site is static pages in `public/` plus one Netlify Function (`netlify/functions/api.mjs`).
All data is kept in **Netlify Blobs** (Netlify's built-in storage), so nothing is lost when you redeploy.

1. In Netlify: **Add new project → Import an existing project → GitHub** → pick this repository.
2. Leave the build settings as they are (they come from `netlify.toml`) and click **Deploy**.
3. Open the site. The first visit asks you to create your admin account. Do this right away.
4. Give students the site address plus the username and password you create for them.

Every push to the `main` branch redeploys the site automatically. Your data stays.

**Free-plan note:** Netlify's free plan gives 300 credits a month. Each successful production deploy uses 15, and normal traffic for a tutoring class uses very little.
So don't redeploy dozens of times a month. Usage is shown under **Usage & billing** in Netlify.

## Run it on your own computer (optional)

Needs Node.js 20 or newer.

```
npm install
npm start
```

Then open http://localhost:3000. Local data is saved in the `data/` folder and is separate from the live site.

## Day-to-day use

1. **Classes** → add a class.
2. **Students** → *Add student*: name, username, password, and tick their classes. Give the student their username and password. (They can change the password after logging in.)
3. **Assignments** → fill in title, Test/Worksheet, total points (T), date, and which classes → *Create & enter grades*.
4. On the assignment page, type each student's score (A) and, for tests, correction points. Press Enter to jump to the next student. Click *Save grades*. Leave blank anything not graded yet.
5. Stats (mean, median, high, low, std dev, score spread) show for each class. Tests also get a second row of stats with corrections.
6. In a class, click a student to see exactly what they see.

Removing a student from a class keeps their grades (they come back if you re-add the student). Deleting a student deletes their account and grades.

## Files

```
public/                  the pages (index.html, app.js, style.css)
lib/core.mjs             all API routes and the grade math
lib/blob-store.mjs       storage on Netlify Blobs
lib/file-store.mjs       storage in local files (for npm start)
netlify/functions/api.mjs  the Netlify Function that serves /api/*
local-server.mjs         runs everything on your computer
netlify.toml             Netlify settings
```
