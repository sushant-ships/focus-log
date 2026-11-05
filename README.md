# Focus Log setup (about 15 minutes, all free)

## 1. Create the database (Supabase)
1. Go to supabase.com, sign up, click New project. Any name. Save the database password somewhere.
2. When it finishes, open SQL Editor > New query, paste everything from `schema.sql`, click Run.
3. Open Project Settings > API. Copy the Project URL and the anon public key.
4. Open `config.js` in this folder and paste both values between the quotes.

## 2. Allow your site to sign in
In Supabase: Authentication > URL Configuration.
- Site URL: your GitHub Pages address, like `https://YOURNAME.github.io/focus-log/`
- Redirect URLs: add the same address.

Then Authentication > Email Templates > Magic Link. Add this line to the body so the email also contains a code you can type on your phone:

    Your code is: {{ .Token }}

Note: Supabase's built in email sender only allows a few emails per hour. That is fine because you only sign in once per device. If you hit the limit later, add a free custom SMTP sender under Authentication > Emails.

## 3. Put it online (GitHub Pages)
1. On github.com click New repository, name it `focus-log`, keep it Public (free Pages needs public), create it.
2. Click "uploading an existing file", drag in everything inside this folder (not the folder itself), commit.
3. Settings > Pages > Source: Deploy from a branch > main > / (root) > Save.
4. After a minute your app is at `https://YOURNAME.github.io/focus-log/`.

The anon key in config.js is public by design. Your sessions are protected by the row level security rules in schema.sql, so only you, signed in, can read or write them.

## 4. Install it
- PC (Chrome or Edge): open the address, click the install icon in the address bar, or menu > Install Focus Log.
- Phone: open the address in Chrome (Android) > menu > Install app. On iPhone use Safari > Share > Add to Home Screen.

Sign in once on each device. After that it stays signed in and also opens offline. Sessions made offline sync when you are back online.

## Using it
- Pick 25/5 or 50/10 (or add your own in Settings), pick a category, press Start.
- Each finished work block is saved with start time, end time, minutes, category and note.
- "Stop & save" logs a partial session. "Add a session I forgot to time" logs one by hand.
- The weekly bar tracks your goal (default 3.5 hours, Monday to Sunday). Use the arrows to see earlier weeks.
- "Export this week (CSV)" opens straight in Excel or Sheets.
