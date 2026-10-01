# Print Wallah: bachi hui cheezein complete karne ki poori guide

Yeh guide `REMAINING_WORK.md` ki remaining cheezon ko seedhi Hinglish mein, ek-ek click aur command ke saath samjhati hai. Isse padhkar local computer par app chalana, Render par publish karna, dukaan ke computer/printer ko jodna, aur launch se pehle checks karna samajh aana chahiye.

> **Zaroori baat:** Project ka core app bana hua hai. Is guide ka matlab app ko dobara banana nahi hai. Bache hue kaam zyada tar aapke accounts, production database, live URL, asli dukaan ke rates/UPI, printer aur business decisions se jude hain.

## Is guide ko kaise padhein

- **Aaj local computer par app chalani hai:** Section 2 padhein. Aapke is computer par setup pehle se hai; agar app chal rahi hai to naye database/user banane ki zaroorat nahi.
- **App ko internet par customers ke liye chalana hai:** Section 3 se 7 kram se karein. Production ke liye deployment, PostgreSQL, persistent file storage, HTTPS aur backups zaroori hain.
- **Kisi asli dukaan ko chalana hai:** Section 8 aur 9 bhi karein. Rates/UPI sahi karna aur asli printer par test ke bina customers na bulayein.
- **Kuch features har dukaan ko chahiye hi nahi:** Section 11 mein optional product decisions hain. Jo chahiye nahi, usko “is launch ke liye nahi chahiye” likhkar defer kar sakte hain.

Status shabdon ka matlab:

- **ZAROORI:** Real customer data/orders lene se pehle karna hai.
- **NAYA LOCAL COMPUTER:** Sirf jab app ko kisi doosre/fresh computer par setup karein. Is computer ka existing local setup dobara na karein.
- **OPTIONAL / FAISLA:** Pehle tay karein business ko waqai chahiye ya nahi; phir sirf haan hone par banayein.
- **HO CHUKA:** Code/check pehle se maujood hai. Isko dobara banana nahi, apne actual data/devices ke saath verify karna hai.

---

## 1. Pehle samjhein: kaun si cheez kahan chalti hai

Print Wallah ke 3 hisson ko alag samjhein:

1. **Website/backend:** Customer portal, Super Admin, Shop Admin aur APIs. Local test mein yeh aapke computer par `localhost:3000` par chalta hai. Live launch mein yeh Render Web Service par chalega.
2. **PostgreSQL database:** Shops, rates, orders, payment state aur print queue yahan rahte hain. Local development mein local PostgreSQL; live launch mein alag Render PostgreSQL use hoga.
3. **Dukaan ka print agent:** Yeh chhota Python program har dukaan ke printer wale computer par chalta hai. Agent live website se apni dukaan ke approved print jobs leta hai aur us computer ke configured printer command ko file deta hai. Website Render par ho sakti hai, lekin agent dukaan ke local computer par hi chalta hai.

Customer file database mein nahi, private disk/folder mein rehti hai. Isliye production mein **database aur uploaded files dono** ka backup/restore plan chahiye.

### Abhi kya pehle se bana hua hai

- Super Admin se shop banana/edit karna, lock/unlock aur subscription/access badhana.
- Har shop ka alag customer URL/QR, apne prices, print options aur UPI details.
- Customer upload, PDF page count, image/photo sheet, preview, price estimate aur server-side amount calculation.
- Cash approval aur UPI intent. UPI intent selected shop ka UPI ID aur server ka amount/order code prefill karta hai. Shop ko apne UPI account mein exact payment dekhkar **khud Verify** karna hai; uske baad hi print queue banti hai. Customer ko UTR type karna zaroori nahi.
- Shop Admin order desk, analytics, shop settings aur agent connection screen.
- Agent job claim/download/result flow.

### Jo abhi baaki hai

- Production Render account/service/database/disk/HTTPS ka setup aur actual restore rehearsal.
- Har asli dukaan ka verified price card, UPI, admin login aur allowed print options.
- Har dukaan ke actual printer, driver aur command par test prints.
- Order se judi customer files ki retention (kitne din rakhni hain) ka business decision aur uske mutabik automated deletion/storage feature. Abhi order wali files apne-aap expire nahi hoti.
- Payment gateway chahiye to provider integration, signed webhook aur test matrix. Abhi gateway/webhook nahi hai.
- Release tests ko final live setup/device/printer par dobara chalana.
- Customer ko baad mein order dhoondhne, extra staff accounts, extra photo behaviors/reports jaise OPTIONAL features par faisla.

---

## 2. Local computer par chalana

### 2.1 Is computer par pehle se app chal rahi ho to

Yahan project folder hai:

```text
D:\Code\Projects\Printing
```

Local app ko dobara start karna ho:

1. Windows mein **Start** kholein.
2. `PowerShell` likhein aur **Windows PowerShell** open karein.
3. Yeh commands ek-ek karke paste karein:

   ```powershell
   cd D:\Code\Projects\Printing
   npm start
   ```

4. Jab terminal mein `Print Wallah listening on port 3000` dikhe, terminal khula rehne dein. Terminal band karenge to local server ruk jayega.
5. Browser mein `http://localhost:3000/` kholein.
6. Shop Admin sign-in seedha `http://localhost:3000/admin` par hai.
7. App health check ke liye `http://localhost:3000/api/health` kholein. `{"status":"ok"}` aana chahiye.

Agar “port 3000 already in use” aaye, mumkin hai app pehle se chal rahi hai. Pehle browser mein `http://localhost:3000/` khol kar dekhein; bina wajah doosra server start na karein.

### 2.2 Fresh/anya Windows computer par local setup — NAYA LOCAL COMPUTER

#### A. Zaroori programs install karein

1. [Node.js official download page](https://nodejs.org/en/download) se **20 ya usse naya LTS** version install karein. Installer mein default options chhod sakte hain.
2. [PostgreSQL Windows installer page](https://www.postgresql.org/download/windows/) se PostgreSQL **14 ya usse naya** install karein. Installation ke waqt `postgres` administrator ka password aap set karte hain. Us password ko safe jagah rakhein.
3. Installer agar **pgAdmin 4** offer kare to install karein; SQL chalane ke liye yeh graphical tool aasaan rahega. Chahein to `psql` command-line tool use kar sakte hain.
4. Sirf print agent bhi isi computer par chalana ho to [Python downloads](https://www.python.org/downloads/windows/) se Python 3.10+ install karein. Sirf website chalane ke liye Python zaroori nahi.
5. Nayi PowerShell window khol kar versions check karein:

   ```powershell
   node --version
   npm --version
   psql --version
   python --version
   ```

   Website ke liye `node` major version 20 ya zyada aur PostgreSQL 14 ya zyada hona chahiye. Agent use karne par Python 3.10 ya zyada hona chahiye. Agar command “not recognized” bole to installer ke baad computer restart karke dobara check karein.

#### B. Project folder rakhein

1. Project ki poori folder copy/checkout karke is computer par rakhein, jaise `D:\Code\Projects\Printing`.
2. PowerShell mein project ke root folder par jayein:

   ```powershell
   cd D:\Code\Projects\Printing
   ```

3. Is folder ke andar `package.json`, `.env.example`, `src`, `public`, `db`, aur `agent` folders dikhne chahiye. `package.json` nahi mil raha to aap project root mein nahi hain.

#### C. PostgreSQL mein app ke liye database/user banayein

Is kaam ke liye ek baar PostgreSQL administrator ke roop mein kaam karna hai. App ke liye alag `printing_user` hoga; app mein `postgres` administrator ka login mat daalein.

**pgAdmin ka tareeqa:**

1. Windows Start se **pgAdmin 4** kholein.
2. Baayen taraf **Servers** ke saamne arrow dabayein. Apna PostgreSQL server kholein; installation ke waqt set kiya `postgres` password maange to woh daalein.
3. `Databases` expand karein aur pehle se bane `postgres` database par right-click karein.
4. **Query Tool** kholein.
5. Neeche wala SQL apne local password ke saath chalaayein. `Choose_a_long_local_password_123` ko apne password se badlein. SQL quotes `'` ke andar single quote password mein ho to use double karein (`'` becomes `''`).

   ```sql
   CREATE ROLE printing_user LOGIN PASSWORD 'Choose_a_long_local_password_123';
   ```

6. Toolbar ka **Execute/▶** button dabayein. “Success”/no error aana chahiye.
7. Nayi query mein database banayein:

   ```sql
   CREATE DATABASE printing_platform OWNER printing_user;
   ```

   `CREATE DATABASE` ko alag se execute karein. Agar “already exists” aaye to database pehle se bana hua hai; naya duplicate na banayein. Agar user/database pehle se hain aur password bhool gaye, admin se user password reset kar sakte hain:

   ```sql
   ALTER ROLE printing_user WITH PASSWORD 'Naya_Local_Password_123';
   ```

8. pgAdmin mein `Databases` par right-click **Refresh** karein. `printing_platform` dikhna chahiye.
9. `printing_platform` par click karein, phir us par right-click **Query Tool**.
10. Extension install karne ke liye yeh chalaayein:

    ```sql
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    ```

11. Neeche `Query returned successfully`/success aaye to database tayyar hai. App ka startup bhi schema initialize karta hai; `npm run db:init` bhi isi database mein tables/extension set karega.

**Agar `psql` use karna ho:** Start se **SQL Shell (psql)** kholein. Server `localhost`, Database `postgres`, Port `5432`, Username `postgres` accept karein; postgres password daalein. Upar ke `CREATE ROLE`, `CREATE DATABASE` alag-alag paste karein. Phir `\connect printing_platform` likhein aur `CREATE EXTENSION ...` chalayein. `psql` mein command tabhi chalti hai jab uske aakhir mein `;` ho.

#### D. Local `.env` file tayyar karein

1. Project root mein `.env.example` hai. Uski copy `.env` naam se banayein:

   ```powershell
   Copy-Item .env.example .env
   notepad .env
   ```

2. Notepad mein ye lines apni local values se bhar kar save karein:

   ```dotenv
   PORT=3000
   NODE_ENV=development
   APP_URL=http://localhost:3000
   JWT_SECRET=YAHAN_RANDOM_SECRET_PASTE_KAREIN
   UPLOAD_DIR=./storage
   MAX_UPLOAD_MB=30
   DATABASE_URL=postgresql://printing_user:APNA_DB_PASSWORD@localhost:5432/printing_platform
   DATABASE_SSL=false
   SUPER_ADMIN_EMAIL=apna-admin-email@example.com
   SUPER_ADMIN_PASSWORD=apna-lamba-unique-password
   DEFAULT_ACCESS_DAYS=30
   ```

3. `DATABASE_URL` mein wahi password daalein jo `printing_user` ko diya. Agar password mein `@`, `:`, `/`, `?`, `#` jaise URL characters hain to connection string toot sakti hai; local ke liye in characters ke bina lamba password chunna aasaan hai. Ya password ko URL-encode karein.
4. `JWT_SECRET` ke liye PowerShell mein yeh command chalayein. Jo random value print ho, use copy karke `.env` mein paste karein. **Is value ko kisi ko na bhejein.**

   ```powershell
   node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
   ```

5. Super Admin ke liye apna email aur strong password set karein. Yeh credentials local app ke Super Admin login hain; kisi default login ko assume na karein.
6. Save karne ke baad Notepad band karein. `.env` private file hai. Isse GitHub par upload/commit nahi karna.

> **Is computer par app pehle se configure hai?** Maujooda `.env` ko overwrite na karein. Pehle check karein ki usme `DATABASE_URL` aur secrets set hain. Local database/user ko dobara banane ki zaroorat nahi.

#### E. Packages, tables aur local website start karein

PowerShell mein project root par:

```powershell
npm install
npm run db:init
npm start
```

- `npm install`: JavaScript packages install karta hai; pehli baar hi lamba lag sakta hai.
- `npm run db:init`: `.env` ke `DATABASE_URL` wale database mein schema/tables tayyar karta hai.
- `npm start`: website/API ko port 3000 par start karta hai.

Terminal mein `Print Wallah listening on port 3000` dekhein. Browser `http://localhost:3000/api/health` par `status: ok` aur `http://localhost:3000/` par login page aana chahiye.

### 2.3 Local Super Admin se pehla test shop banayein

1. Browser mein `http://localhost:3000/` kholein.
2. `.env` ke `SUPER_ADMIN_EMAIL` aur `SUPER_ADMIN_PASSWORD` se login karein.
3. Dashboard par **＋ Add a shop** dabayein.
4. Test-only values bhar dein: shop name, owner, phone, email (optional), address, city, initial access days, shop-admin email/password.
5. UPI test karna ho to test shop ke field mein test UPI ID daalein. Kisi asli payment ko test ke naam par trigger mat karein.
6. “Printing options this shop supports” mein sirf test printer ki supported sizes/types/capabilities select karein.
7. “Starting price card” rates review karein; phir **Create shop + QR** dabayein.
8. Jo result khulta hai usme customer URL, QR aur **print-agent token** hota hai. Token ek baar copy karke safe local jagah rakhein. Asli shop mein ise public chat/email mein mat bhejein.
9. **Open portal** dabayein ya QR scan karein. URL `/shop/SHOP_ID` format mein hoga. Kisi doosre computer/phone se `localhost` URL use nahi hoga; us device ko aapke local server ka network address ya deployed URL chahiye.
10. Shop Admin login test ke liye `http://localhost:3000/admin` kholein, shop admin ka email/password daalein.

Local site chalti rahe iske liye `npm start` wala terminal khula rehna chahiye. Band karne ke liye terminal mein `Ctrl+C` dabayein.

### 2.4 Local automated checks

Project root PowerShell se:

```powershell
npm test
python -m unittest discover -s agent -p '*test*.py'
```

`npm run smoke` API ke through temporary shops/orders banata hai aur cleanup karta hai. Ise **production database par kabhi na chalayein**. Sirf disposable local/test database aur usse connected local server par use karein. Pehle se chal rahi asli shop wali local DB par smoke test chalane ki zaroorat nahi.

---

## 3. Render par le jaane se pehle: code ko private GitHub repository mein rakhna — ZAROORI

Render ko source code dene ke liye project GitHub/Git provider par hona chahiye. Repository **Private** rakhein, jab tak aap code sabke liye public nahi karna chahte.

### 3.1 GitHub par khali private repository banayein

1. Browser mein [github.com](https://github.com/) kholein aur apne account mein sign in karein.
2. Upar **+** menu ya `github.com/new` kholein.
3. Repository name, jaise `print-wallah`, bharein.
4. Visibility mein **Private** select karein.
5. “Add a README”, “Add .gitignore”, ya license abhi select na karein. Local project mein ye files pehle se hain; blank remote rakhne se pehla push seedha hota hai.
6. **Create repository** dabayein. Agle Quick Setup page par jo HTTPS URL dikhe, use copy karein. Is format ka hoga: `https://github.com/ACCOUNT/print-wallah.git`.

### 3.2 Git initialize, secret check, commit aur push karein

Nayi PowerShell window project root par:

```powershell
cd D:\Code\Projects\Printing
git status
```

Is waqt agar “not a git repository” aaye, yahi expected ho sakta hai; phir:

```powershell
git init -b main
git status --short
```

Ab **important security check** karein:

```powershell
git check-ignore -v .env
git status --short
git ls-files .env agent/config.json
```

- `git check-ignore` ko `.env` ke liye `.gitignore` rule dikhana chahiye.
- `git ls-files .env agent/config.json` ka output **khali** hona chahiye. Agar in files ka naam aaye to woh pehle se Git mein tracked hain; sirf `.gitignore` add karne se tracking nahi rukti. Unhe Git index se safely untrack karna aur agar koi secret pehle remote par push hua ho to woh secret rotate karna zaroori hai.
- `.env`, `storage/` ke customer docs, `agent/config.json`, local database folder, passwords/token wali file list mein nahi aani chahiye.
- Agar `.env` status mein dikh rahi hai, `git add` mat karein. `.gitignore` fix karke pehle `git status` mein confirm karein.

Files stage karke dobara list dekhein:

```powershell
git add .
git status --short
git diff --cached --name-only
```

List mein sirf code/docs/example config/test files hon. `agent/config.example.json` theek hai; **`agent/config.json` actual token wala file hai, ise upload nahi karna.** `storage` mein actual customer documents nahi hone chahiye.

List theek ho tabhi commit/push karein:

```powershell
git commit -m "Prepare Print Wallah deployment"
git remote add origin https://github.com/ACCOUNT/print-wallah.git
git push -u origin main
```

Command mein `ACCOUNT` ko apne GitHub account se aur URL ko GitHub page se copy kiye URL se badlein. GitHub sign-in prompt aaye to GitHub ka normal authorization complete karein. Remote pehle se configured ho to `git remote add origin` error dega; pehle `git remote -v` dekhein aur galat remote ko bina samjhe overwrite na karein.

> GitHub existing project push instructions: [GitHub Docs](https://docs.github.com/en/migrations/importing-source-code/using-the-command-line-to-import-source-code/adding-locally-hosted-code-to-github).

---

## 4. Render PostgreSQL banana — production ke liye ZAROORI

### 4.1 Database create karein

1. Browser mein [dashboard.render.com](https://dashboard.render.com/) kholein aur Render account/workspace mein sign in karein.
2. Top-right **+ New** dabayein, phir **Postgres** choose karein. Dashboard labels samay ke saath badal sakte hain; Render guide mein “Create and Connect to Render Postgres” dekhein.
3. Database ka naam, jaise `print-wallah-prod-db`, enter karein. Naam mein `prod` likhna useful hai taaki test DB se confusion na ho.
4. Region choose karein. App Web Service bhi **isi region** mein banana hai, taaki private/internal connection use ho.
5. Database/user name aur plan choose karein. Plan ke cost, storage, connection limits aur recovery window ko select karne se pehle screen par padhein.
6. **Create Database** dabayein aur status `Available`/ready hone tak wait karein.
7. Database page ke **Connect** menu/Info section se **Internal Database URL** copy karein. Yeh secret hai. Isko chat, code ya GitHub mein paste nahi karna.
8. App same Render region/account mein hogi to internal URL `DATABASE_URL` mein dena. Apne laptop se DB connect karna ho to external URL hota hai aur TLS ki requirement alag hoti hai; Render app ke liye internal preferred hai.

### 4.2 PostgreSQL backup/recovery ka matlab samjhein

- Render database ke available recovery/backup features plan se badal sakte hain. Database page mein **Recovery/Backups** section khol kar dekhein ki aapke chosen plan par PITR, export aur retention kya milta hai.
- Paid plans ki recovery window aur logical export ki conditions Render ki current policy par depend karti hain. Free database ko backup-protected maan kar real customer data na rakhein.
- Upload disk ka backup database ke saath related hai. Sirf DB restore karke agar matching file backup na ho to order rahega par document missing ho sakta hai.
- Launch se pehle staging/temporary recovery target par ek **restore rehearsal** karein. Original production DB par restore karke data overwrite na karein.

**Database export download karne ke dashboard steps:**

1. Render mein PostgreSQL resource open karein.
2. **Recovery** tab/page kholein.
3. Agar plan allow kare aur koi export already running na ho to **Create export** dabayein.
4. Status ready/complete hone tak wait karein. Usi Recovery page mein export ka download link dikhe to archive ko secure backup folder mein download karein; ismein shop/customer records hain, public Drive/repo mein na rakhein.
5. Agar **Create export** disabled/missing ho, chosen plan mein logical export included na ho sakta hai. Render ke backup docs/plan check karein ya local PostgreSQL client `pg_dump` se external DB ka export arrange karein. Password-containing DB URL command history mein paste na karein.

**Safe restore rehearsal:**

1. Production se alag **blank test database** banayein. Existing important DB ka naam target mein na dein.
2. Render export archive use kar rahe hon to Render docs ka “Restoring from a logical backup” section kholein. Directory export ke liye commands ka pattern `tar -xzf BACKUP.dir.tar.gz` aur phir `pg_restore --dbname=TEST_DATABASE_URL --verbose --no-owner --no-privileges --format=directory EXTRACTED_EXPORT_FOLDER` hai. Restore command se pehle URL mein **test database** ka naam confirm karein; `--clean` flags target database ke objects delete kar sakte hain.
3. Agar local Postgres tools “not recognized” bolein to PostgreSQL ke `bin` folder ko PATH mein add karein ya Postgres SQL Shell/client installer use karein.
4. Test app ko sirf test DB se connect karke open karein; ek restored test order/details aur uski matching file access check karein.
5. File disk ka restore alag hai. Render persistent disk restore existing disk ko purane snapshot se overwrite kar sakta hai; ise production disk par bina approved recovery plan click na karein. Rehearsal ke liye separate/staging disk/instance par file copy/snapshot restore karein.
6. Rehearsal ke baad record karein: kisne kiya, kis backup date se, DB+file dono restored hue, kitna samay laga, missing file/order to nahi.

Official info: [Create/connect Postgres](https://render.com/docs/postgresql-creating-connecting) aur [Render Postgres backups/recovery](https://render.com/docs/postgresql-backups).

---

## 5. Render Web Service banana aur secrets set karna — production ke liye ZAROORI

### 5.1 Web Service create karein

1. Render dashboard mein top-right **+ New → Web Service** dabayein.
2. Git provider connect nahi hai to GitHub connect karein.
3. Apni private `print-wallah` repository ke saamne **Connect** dabayein.
4. Form mein service ka naam, jaise `print-wallah-prod`, choose karein.
5. Branch `main` choose karein.
6. Runtime/language `Node` ho.
7. Region wahi choose karein jo Render PostgreSQL ka hai.
8. Build command:

   ```text
   npm install
   ```

9. Start command:

   ```text
   npm start
   ```

10. Plan choose karte waqt persistent disk requirement dekh lein. Render disk app ke local filesystem par uploads bachane ke liye chahiye aur current Render docs ke mutabik paid service/disk availability lagti hai. Free/ephemeral disk par real customer uploads deploy/restart ke baad bachne ki guarantee nahi.
11. Abhi URL final nahi bana to `APP_URL` baad mein environment page par set karenge.
12. **Create Web Service** dabayein. Pehla deploy start hoga.

Render guide: [Node/Express Web Service](https://render.com/docs/deploy-node-express-app), [Web Services](https://render.com/docs/web-services).

### 5.2 Persistent disk attach karein

1. Render mein naye `print-wallah-prod` Web Service ko kholein.
2. Service menu mein **Disks** ya **Disk** page kholein.
3. **Add Disk** dabayein.
4. Mount path yeh rakhein:

   ```text
   /var/data/print-wallah
   ```

5. Disk size expected PDF/photo volume ke liye choose karein; chhoti se shuru karke usage monitor karein. Render ka disk size baad mein badh sakta hai, ghatana mushkil/unsupported ho sakta hai; current dashboard warning dekhein.
6. **Add Disk/Save** dabayein. Is app ka `UPLOAD_DIR` bhi isi exact mount path par set hoga.
7. Disk connect karne se deploy/restart ho sakta hai. Isliye settings poori karne ke baad deploy logs dobara check karein.

Render disk docs: [Persistent Disks](https://render.com/docs/disks). Disk sirf isi mount path ke andar files ko deploy/restart ke baad bachata hai; baaki service filesystem temporary hai.

### 5.3 Environment variables set karein

1. Render Web Service page ke left menu mein **Environment** kholein.
2. **+ Add Environment Variable** dabayein. Har key/value ko alag row mein add karein. Agar UI mein **Add from .env** dikhe bhi, local `.env` poori upload na karein; usmein local DB/password hote hain, production ke values alag hone chahiye.
3. Neeche ke production values add karein:

   | Key | Value mein kya daalna hai |
   |---|---|
   | `NODE_ENV` | `production` |
   | `DATABASE_URL` | Section 4 se copy ki hui **Render Internal Database URL** |
   | `DATABASE_SSL` | Same region ki internal URL ke liye aam taur par `false`; agar Render DB page is setup ke liye TLS kahe to uska instruction follow karein |
   | `APP_URL` | Render service ka public HTTPS root, jaise `https://print-wallah-prod.onrender.com`; end mein `/` nahi |
   | `JWT_SECRET` | Naya production-only random secret; local `.env` wali value se alag |
   | `SUPER_ADMIN_EMAIL` | Aapka production Super Admin email |
   | `SUPER_ADMIN_PASSWORD` | Naya, lamba, unique production password |
   | `UPLOAD_DIR` | `/var/data/print-wallah` (Disk mount path se bilkul same) |
   | `MAX_UPLOAD_MB` | `30` ya aapka approved upload limit |
   | `DEFAULT_ACCESS_DAYS` | `30` (new shop ka initial access; baad mein Super Admin se extend kar sakte hain) |

4. Production `JWT_SECRET` banane ke liye local PowerShell mein yeh chalayein aur output ko Render ke secret value field mein paste karein. Value ko file, GitHub, screenshot, ya public support chat mein na daalein:

   ```powershell
   node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
   ```

5. Email/password strong hon. Password manager mein save karein. Kisi aur ko Super Admin password na dein; shop ko alag Shop Admin login dena hai.
6. Page ke save dropdown mein **Save, rebuild, and deploy** ya equivalent deploy option choose karein. Save-only karenge to service purane variables par chalti reh sakti hai.
7. Deploy poora hone tak **Events/Deploys** kholein. Logs mein startup error nahi hona chahiye aur `Print Wallah listening...`/live state aani chahiye.

Environment UI ke current steps: [Render environment variables docs](https://render.com/docs/configure-environment-variables).

### 5.4 Pehla deployed health/login check

1. Render Web Service page ke top par public URL copy karein, jaise `https://print-wallah-prod.onrender.com`.
2. Browser mein `PUBLIC_URL/api/health` kholein. Example: `https://print-wallah-prod.onrender.com/api/health`. JSON mein `status: ok` hona chahiye.
3. `PUBLIC_URL/` kholkar production `SUPER_ADMIN_EMAIL`/password se login karein.
4. Super Admin dashboard khulta hai to schema startup par initialize hua. Agar 500/deploy failed ho, Render **Logs** kholein; logs ka poora secret-bearing hissa public na karein.
5. Render service ke domain/settings area mein HTTPS lock indicator check karein. Public customers ko `https://` QR/URL hi dein.
6. `APP_URL` galat ho to **Environment** mein exact URL (trailing slash ke bina) correct karke save/deploy karein; phir test shop banakar uska URL/QR check karein.

> Render ke Free web service limitations (sleep/spin-down, disk, plans) badal sakte hain. Real-time dukaan workflow ke liye chosen plan ki current limits aur uptime/customer expectations compare karein. Is guide mein kisi plan ki cost guarantee nahi di gayi.

---

## 6. Render par safe staging/test aur launch order

### Pehle staging (test copy) kyon

Production database mein automated smoke test shops/orders banata hai. Isliye `npm run smoke` ko production URL/DB par na chalayein. Behtar:

1. Render mein alag staging Web Service **aur alag staging PostgreSQL DB** banayein (ya disposable local DB use karein).
2. Staging ke credentials production se alag rakhein.
3. `APP_URL` staging service URL ho.
4. Persistent upload disk/storage staging mein ho, agar upload test karna hai.
5. Staging par browser se test shops banayein. Smoke test sirf staging ke against chalayein.
6. Staging records delete karne ke liye code/UI mein deletion feature available na ho sakta hai. Test shops ko naam mein `TEST - ...` rakhein aur lock kar dein; disposable DB use karna safer hai.
7. Production mein manual UI checks karein aur koi real UPI payment test tabhi karein jab owner ne test amount/account approve kiya ho. Production par automated smoke test na chalayein.

### Final deploy ke baad code update ka process

1. Local changes/test pass karein.
2. GitHub par code `main` branch push karein:

   ```powershell
   git status
   git add .
   git status --short
   git commit -m "Describe the change"
   git push
   ```

3. Render mein Web Service → **Events/Deploys** kholein. Auto deploy enabled ho to build khud start hota hai. Warna **Manual Deploy → Deploy latest commit** dabayein.
4. Deploy live hue bina nayi functionality customers ko test na karayein.
5. Persistent disk attach hai to deploy ke dauran service restart ho sakti hai; ek test upload deploy ke baad bhi khulta hai ya nahi verify karein.

---

## 7. Shop banana aur har dukaan ke details sahi bharna — ZAROORI

Har dukaan ke liye Super Admin ye process alag se kare. Pehle owner se likhit/clear confirmation lein ki naam, rates, UPI aur supported printer options sahi hain.

### 7.1 Shop create karein

1. Deployed site ke root `PUBLIC_URL/` par Super Admin ke roop mein login karein.
2. Dashboard par **＋ Add a shop** dabayein.
3. Fields fill karein:
   - **Shop name / Owner name / Contact number:** board/business ke mutabik.
   - **Shop email:** optional contact.
   - **Address / City:** customer ke liye sahi location.
   - **Initial access (days):** owner ke saath tay duration; default 30 din.
   - **Shop admin email/password:** dukaan ke operator ka alag login. Password minimum 10 characters; secure tareeqe se owner ko dein.
   - **UPI ID:** sirf owner se verify karne ke baad, jaise `name@bank`; galat ID mein customer doosre account ko pay kar sakta hai.
   - **UPI payee name:** payment app mein dikhne wala account/shop naam.
4. **Printing options this shop supports:** dukaan ke actual printer/paper ke bina supported option tick na karein. A4/A3, normal/glossy, color, double-sided, photo sheets ko printer se check karein.
5. **Starting price card:** ₹/printed sheet ke roop mein owner ke approved rates type karein. Example default rates ko real rates na samjhein. Har enabled combination ke liye rate confirm karein.
6. Duplex rule current app mein pages ko physical sheets par charge karta hai (`ceil(pages / 2)`). Owner se confirm karein ki woh isi rule par sahmat hai.
7. **Create shop + QR** dabayein.
8. “Shop ready” screen par:
   - Customer URL copy karein.
   - **Download QR** se PNG save karein.
   - **Open portal** se link test karein.
   - Agent token ko turant private password manager/secure operator record mein copy karein. Token dobara dikhayi na de to Shop Admin → Shop settings se rotate karna padega; purana agent token phir kaam nahi karega.
9. QR ko customer counter par lagane se pehle mobile phone se scan karke URL/domain/shop name verify karein.

### 7.2 Shop Details/Edit/Lock/Expiry samjhein

- Shop row ka **Details** button: phone/address/admin login, rates, UPI, print options, QR, URL, agent heartbeat aur recent orders dekhne ke liye.
- **Edit shop**: contact, admin email/password reset, UPI, supported print options aur rates badalne ke liye. Password reset field blank chhodein to existing password rahega.
- **Extend**: access days badhane ke liye; system existing future expiry ke baad days jodta hai.
- **Lock/Unlock**: shop portal ko temporarily rokne/restore karne ke liye. Lock tab karein jab owner approval/contract/access issue ho; unlock se pehle reason clear karein.
- Expiry date Details/list mein dekhein. Expired shop ko orders lene se pehle owner se renew/extend approve karayein.

### 7.3 Har dukaan ka price test

Shop Admin ko sign in kara kar customer portal khol kar chhota controlled test karein:

1. 1-page PDF upload karein; page count `1` dikhna chahiye.
2. Default B&W A4, 1 copy ka displayed quote owner-approved price ke barabar check karein.
3. Color enable ho to B&W vs color ka amount compare karein.
4. A3 enable ho to A3 amount check karein.
5. 2 copies, page range, duplex aur photo sheet (if enabled) alag-alag try karein; actual expected amount paper par calculate karke compare karein.
6. Ek uploaded PDF ka page range `1-2` select karke preview/config/order options check karein. Invalid range ko accept nahi hona chahiye.
7. Galat rate mile to test order se pehle Super Admin → Details → Edit shop → price card correct karein.
8. Test orders ko operator ke saath pehchan kar production queue mein accidentally print na hone dein. Real shop mein customer files se test na karein; apni harmless dummy file use karein.

---

## 8. Dukaan ke computer par printer/agent set karna — asli printing se pehle ZAROORI

### 8.1 Dukaan ki hardware list pehle likhein

Har location ke liye note karein:

- Printer ka brand/model aur USB/network connection.
- Printer ka OS driver installed hai ya nahi.
- Shop computer ka Windows/macOS/Linux version.
- Printer mein actual available paper (A4/A3, normal/glossy), color/mono, duplex support.
- Kya computer/customer app URL internet se khol sakta hai.
- Kya printer Windows queue mein correct naam se dikhta hai.

Print Wallah printer capabilities ko khud discover nahi karta. Admin screen mein tick kiya option tabhi customer ko offer hota hai, lekin actual printer output ka faisla OS driver/command karta hai.

### 8.2 Printer driver aur test file

1. Printer ko dukaan ke computer se USB/network se connect karein.
2. Printer manufacturer ki official site se exact model ka driver install karein; random driver website se nahi.
3. Windows **Settings → Bluetooth & devices → Printers & scanners** kholein. (Windows version mein title thoda badal sakta hai.)
4. Printer select karein → **Print test page**. Paper physically nikle, correct printer se aaye.
5. Windows printer ka exact displayed name note karein (agent config ke `printer_name` mein yahi likhna hoga).
6. PDF print karne wala local program/command install/configure karein. Windows ke liye project docs SumatraPDF jaise command-line PDF print program ka example deti hain, lekin installed version ke exact flags verify karna zaroori hai. CUPS (`lp`) wala sample sirf CUPS/Linux/macOS environment ke liye hai; Windows mein usse copy-paste na karein.
7. Pehle command-line se harmless test PDF print karke dekhein. UI button press hona printing proof nahi; paper inspect karein.

### 8.3 Python agent install/configure karein

1. Shop computer par Python 3.10+ install karein. PowerShell/Terminal mein `python --version` chalayein.
2. Project ke `agent` folder ko shop computer par secure tareeqe se copy karein (ya GitHub private repo se authorized deployment copy lein). Isme customer files nahi hoti.
3. PowerShell mein:

   ```powershell
   cd D:\Path\To\Printing\agent
   Copy-Item config.example.json config.json
   notepad config.json
   ```

   `D:\Path\To\Printing` ko wahan ke real project folder se badlein. Project ko dukaan ke PC par poora rakhna comfortable na ho to IT operator se sirf agent folder safely install karayein.

4. `config.json` mein yeh values bharein:
   - `server_url`: Render ka root URL, jaise `https://print-wallah-prod.onrender.com` — `/api` ya trailing slash na lagayein.
   - `shop_id`: Shop create hone par diya public Shop ID.
   - `agent_token`: “Create shop + QR” ke result se copy kiya one-time token; ya Shop Admin → **Shop settings → Rotate agent token** se naya token.
   - `agent_name`: jaise `Front counter PC`.
   - `printer_name`: Windows printer list ka exact printer name.
   - `poll_seconds`: example `8` rehne dein, jab tak reason na ho badalne ka.
   - `print_command`: Windows ke liye installed PDF printer/driver ke tested argument array. `{file}` placeholder zaroor ho. CUPS `lp` sample Windows par na use karein.

5. `config.json` save karein. Yeh file `.gitignore` mein hai; isme live `agent_token` hota hai, GitHub/email/public chat par na bhejein.
6. Agent chalayein:

   ```powershell
   cd D:\Path\To\Printing\agent
   python print_agent.py
   ```

7. Console/log mein polling/auth errors na ho. Shop Admin `PUBLIC_URL/admin` par sign in → **Shop settings** kholein. Top par agent status **online/last heartbeat** dikhna chahiye. Heartbeat na aaye to Section 12 troubleshooting dekhein.
8. Agent chalta rahe iske liye is terminal ko khula rakhein. Production use mein Windows login startup/Task Scheduler service set karna baad ka operational step hai; pehle manually stable print test karein. Agent ko admin printer account/permission ke bina Windows service ke roop mein na chalayein.

### 8.4 Actual test print matrix

Owner ki permission se dummy PDF/photo use karke har enabled capability test karein:

| Test | Kya verify karna hai |
|---|---|
| B&W A4, 1 page | Sahi printer, B&W, correct size, margins |
| Color A4 | Real color output aur price |
| A3, agar enabled | A3 tray/paper, orientation, print scaling |
| 2 copies | Do sets aaye, ek nahi/teen nahi |
| Page range (jaise `1-2`) | Wahi pages print hue |
| Duplex | Front/back orientation aur sheet count |
| Portrait + landscape | Content cut/rotate na ho |
| Glossy/photo sheet | Sahi media/tray, selected size, crop |
| Photo sheet | Quantity, dimensions, cut guides, margins |
| Printer offline/retry | Operator ko pata ho, duplicate copy na nikal jaaye |

Har physical page inspect karein. Browser preview final color/margins ka guarantee nahi deta.

### 8.5 Order flow dukaan mein kaise chalega

1. Customer order bhejta hai.
2. Cash ho to Shop Admin → **Orders & queue** → order row mein **Confirm cash** tab dabayein jab cash waqai le liya ho.
3. UPI ho to dukaan ke bank/UPI app mein exact amount aur order code/transaction details milayein. **Verify UPI receipt** tabhi dabayein jab paisa dukaan ke account mein aaya ho. Customer app se wapas aaya ya screenshot dikhaya, itna akela proof nahi.
4. Verify/confirm hone ke baad order queue mein aata hai. Agent job leta hai aur printer command chalaata hai.
5. Shop Admin **Orders & queue** mein `printing`/completed/failed status dekhe.
6. Agent `completed` bataye to bhi page physical print inspect karein. Command successful hona printer se sahi paper nikalne ka proof nahi.
7. Failed/uncertain order ko turant retry na karein. Pehle spooler/printer tray inspect karein ki paper pehle hi to nahi nikla; duplicate print se bachne ke baad hi retry karein.

---

## 9. Payment: customer aur dukaan ki exact zimmedari

### Abhi enabled manual UPI flow

- Super Admin shop ke form mein actual shop UPI ID/payee set karta hai.
- Customer Pay Online tap karta hai; UPI app supported device par open hoti hai aur payee/amount/order code prefilled hote hain. Customer UPI PIN **sirf apne UPI app mein** enter karta hai. Print Wallah website kabhi UPI PIN nahi leti.
- Order initially payment-pending/review mein hota hai. Customer ko UTR manually type karna required nahi.
- Shop staff apne UPI/bank account mein us exact payment ko check karke Shop Admin order desk mein **Verify UPI receipt** dabata hai. Is staff action ke baad hi job queue hota hai.
- Agar customer payment cancel kare/fail ho, gateway callback na hone ki wajah se app ko har app ka result automatic pata nahi chalta. Shop order ko pending chhod sakta hai, ya reconcile karke reject/cancel kar sakta hai. Double-charge se bachne ke liye customer ko payment app ka result check karna chahiye.
- Desktop browser par installed UPI handler na ho to link nahi khulega. Phone se test karne ke liye **deployed HTTPS URL** ya phone se reachable LAN URL kholein. Phone par `localhost:3000` ka matlab phone khud hai, aapka laptop nahi.
- Live payment sirf shop owner ke confirmed receiving account par test karein. Test karne ka amount pehle agree karein aur test payment bhi real money move karta hai.

### Automatic gateway verification chahiye? — alag engineering project

Yeh sirf Render mein ek secret add karne se complete nahi hota. Iske liye:

1. India mein supported merchant payment provider/account choose karein; fee, settlement, refund/dispute aur KYC terms owner samjhe.
2. Provider ke **test/sandbox** account mein server API key aur webhook signing secret lein.
3. Code mein server-side payment intent/session creation implement karein; har session ko exact Print Wallah order ID + server amount + INR currency se jodein.
4. Public HTTPS webhook route add karein; raw request body par signature validate karein. Secret sirf Render Environment mein rakhein.
5. Duplicate webhook ko duplicate payment/job na banne dene ke liye provider event ID unique store karein (idempotency).
6. Wrong amount/currency/order/account/signature, late/duplicate/out-of-order webhook, timeout, cancel, refund aur charge dispute ke cases handle karein.
7. Tests add karein; provider sandbox ke test payments run karein.
8. Live provider credentials set karein, prod webhook URL register karein, phir controlled small live transaction reconcile karein.
9. Tabhi UI mein automatic verified status promise karein. Jab tak yeh engineering work nahi hota, manual shop verification mode ko hi customer/staff ko clearly batayein.

**Abhi launch ke liye kya choose karein:** Agar dukaan staff har order ki UPI receipt dekh sakta hai to manual flow rakhna sabse seedha hai. Agar staff account reconcile nahi karega to automatic gateway project launch se pehle karna hoga; UPI return ko paid maan lena allowed/safe solution nahi.

---

## 10. Files rakhne/deletion ki policy — production se pehle ZAROORI

Current behavior: jo upload order nahi banta woh expiry ke baad cleanup hota hai. **Order se judi uploaded file aur generated print PDF abhi indefinitely rakhe jaate hain.** Real customer documents hain; isliye bina policy ke live volume badhta rahega.

### Faisla kaise karein

1. Business owner se yeh jawab likhwaayein: failed/completed order ka original file kitne din reprint/dispute ke liye chahiye? Generated photo PDF kitne din? Order ki non-file metadata/audit history kitne samay?
2. Dukaandar jo promise karega, uske mutabik customer ko short privacy/retention notice dikhana hai.
3. Apne jurisdiction ke privacy/accounting rules ko business adviser se verify karein. Is guide ko legal advice na samjhein.
4. Disk capacity calculate karein: ek mahine mein uploads ka approximate GB × desired retention months + headroom. Render Disk page par usage regularly check karein.
5. Policy decide karne se pehle automatic order-file deletion feature abhi bana hua nahi. Is feature ko code/migration, cleanup scheduler, audit behavior, missing-file behavior aur tests ke saath implement karna hoga. Isliye file deletion ko haath se database se random rows delete karke “solve” na karein.
6. Backups mein bhi files ho sakti hain. Active storage se delete hone ke baad backup retention se kab delete hoti hain, yeh backup plan mein likhein.

**Complete tab:** retention days owner-approved hon, code us policy ko safe tarike se lagu kare, file+DB backup policy match kare, aur tests verify karein ki recent/active order jaldi delete nahi hote.

---

## 11. Jo features faisla hone ke baad hi karne hain — OPTIONAL / FAISLA

Har item par owner ke saath `Required for launch: YES/NO` likhein. NO ho to is launch ke baad ke liye record kar dein; YES ho to implementation + tests complete karein.

### A. Customer order ko baad mein dobara dhoondhna

Abhi customer page khula ho to order status poll karta hai; browser band ho gaya to random order code se simple tracking/recovery flow limited hai. Decide karein customer ko receipt link/SMS chahiye?

Agar YES:

1. Product owner decide kare ki receipt email/SMS bhejna hai ya secure tracking link dena hai.
2. High-entropy unguessable token ya suitable identity verification design karein.
3. Tracking page mein status dikhayein, uploaded document/payment secret doosre ko expose na karein.
4. Browser close/reopen, alag mobile, cancelled/payment pending/completed cases test karein.

Abhi email/SMS provider integration ko available assume na karein; extra provider/credentials/cost lag sakte hain.

### B. Ek shop mein multiple staff logins

Abhi ek shop par ek admin credential hai. Agar owner ko cashier aur print operator alag chahiye:

1. Roles likhein: kaun cash confirm kare, UPI verify kare, settings/rates badle, staff add kare.
2. Shop-scoped users/roles, invitations, password reset/revoke, audit attribution implement karein.
3. Do shops ke staff se cross-shop tests karein.

Alag staff roles nahi chahiye to is item ko defer karein; admin password share karne ke bajaye owner ek responsible account rakhe.

### C. Photo par multiple alag images

Current photo sheet ek uploaded image ko requested count tak repeat karta hai; ek sheet par alag-alag family photos select karne ka flow nahi.

Agar YES: user flow, upload limits, per-image cropping, sheet layout, page count/pricing define karein; generated PDF ko screen aur printer par test karein.

### D. Extra reporting

Shop Admin mein date-filtered daily analytics aur Super Admin totals/shops analytics already hain. Agar XLS/CSV export, weekly report, location comparison ya payment breakdown chahiye to exact columns/date timezone likhein; phir implementation karein.

---

## 12. Production final checks: click-by-click checklist — ZAROORI

Yeh production deploy ke baad **dummy shop/file** se karein. Actual users ko QR dene se pehle har box complete karein. `npm run smoke` production par **mat** chalayein.

### A. Deployment/backup

- [ ] `PUBLIC_URL/api/health` kholne par `status: ok`.
- [ ] `PUBLIC_URL/` HTTPS lock ke saath open.
- [ ] Render Environment mein production `DATABASE_URL`, `APP_URL`, `JWT_SECRET`, Super Admin creds, `UPLOAD_DIR` set; local secrets re-use nahi.
- [ ] Disk mount path aur `UPLOAD_DIR` exact same.
- [ ] Deployment ke baad dummy file upload karke redeploy/restart ke baad file open karke verify.
- [ ] PostgreSQL backup schedule aur file-disk backup/snapshot samjha; owner/operator ko restore permission maloom.
- [ ] Staging par restore rehearsal se ek dummy order aur uski file kholkar verify.
- [ ] Render service ke **Logs/Events/Metrics** dekhne ka responsible operator aur notification email/team set. Disk/storage usage regularly check karne aur full disk/deploy/API failure par kis ko alert milega yeh likha.
- [ ] Error monitoring ka decision record kiya. Agar Render logs/alerts kaafi nahi to approved monitoring tool integrate karne ka task/owner set; monitoring tool mein secrets/files log na hon.

### B. Super Admin

- [ ] Root URL par production credentials se login.
- [ ] Sign out dabayein; refresh karein; restricted dashboard access na ho. Phir sign in.
- [ ] **＋ Add a shop** se staging/test shop create; Details open; rates/UPI/access/QR sahi.
- [ ] **Edit shop**, save, Details mein update verify.
- [ ] **Extend** se test shop date update.
- [ ] **Lock** karke customer portal reject/blocked state check; phir **Unlock**.
- [ ] QR PNG download, phone se scan, URL correct domain aur shop ID.
- [ ] Galat shop ID open karke proper invalid shop message.
- [ ] Aisa real customer/order data create karke smoke test na karein.

### C. Shop Admin/customer/payment

- [ ] `/admin` kholein; Shop Admin login seedha dikhna chahiye.
- [ ] Shop A admin se login karke apni shop name/dashboard sahi; Shop B ke URL/data/files/orders access na ho.
- [ ] Test shop portal par dummy PDF upload; page count, preview, settings, price quote check.
- [ ] Image upload aur photo sheet sirf supported shop configuration par test.
- [ ] Cash test order: jab tak admin **Confirm cash** nahi karta, agent ko job nahi milni chahiye; confirm ke baad queue check.
- [ ] UPI test se pehle owner ka receiving UPI ID aur small amount approve. Mobile phone par Pay Online tap, displayed UPI payee/order/amount compare; **PIN enter karke paise bhejna sirf owner ki explicit approval par**. Agar actual payment nahi karni to intent page par ruk kar cancel karein.
- [ ] Shop UPI app mein payment received dikhne ke baad Shop Admin → **Orders & queue** → **Verify UPI receipt**. Check karein tab tak job queue mein nahi, verify ke baad hi queue mein aaya.
- [ ] UPI app se return ko automatic success na samjhein; app order status verified tab tak pending hoga jab tak staff verify nahi kare.

### D. Agent/physical print

- [ ] Shop Admin → **Shop settings** mein agent heartbeat recent/online.
- [ ] Dummy PDF queue ho; agent file download kare; sahi printer physical paper de.
- [ ] Paper par copy count, pages, mode, orientation, scaling, double-sided/color (if enabled) check.
- [ ] Queue, printing, completed status order row mein dikhe.
- [ ] Printer offline ya command fail karke staff procedure rehearsal karein; uncertain output inspect hone tak retry na karein.

### E. Mobile, tablet, keyboard aur screen states

Yeh har customer/admin page par staging/dummy data ke saath karein:

1. Chrome ya Edge mein deployed **staging URL** kholein. `F12` dabayein (ya page par right-click → **Inspect**).
2. DevTools toolbar mein phone/tablet jaisa **Toggle device toolbar** icon dabayein. Shortcut aam taur par `Ctrl+Shift+M` hota hai.
3. Dropdown se ek phone model (jaise Pixel/iPhone) choose karein. Customer portal par upload, preview, settings, price, Cash/Online buttons, order status check karein. Page ko left-right scroll kiye bina poora content padhna/click karna chahiye.
4. Tablet preset choose karein; customer upload, shop table/order actions aur modal form ki alignment check karein.
5. Device toolbar off karke normal desktop width par Super Admin, Shop Admin, customer portal tino check karein.
6. Keyboard ke `Tab` se har button/input tak jayein. Focus outline dikhni chahiye; `Enter` se button/submit kaam kare; `Shift+Tab` se pichhle control par aaye.
7. Required form khaali submit karein; invalid email/negative copies/invalid page range (PDF mein `0-9999`) try karein. App clear message de aur galat order/price create na ho.
8. Upload progress, empty order list/analytics, server/API error aur success state dekhein. Console mein uncaught errors na hon. Console screenshot share karne se pehle tokens/PII inspect karein.

### F. Staging-only negative/security tests

In tests ka kuch hissa code/API automated tests maangta hai; sirf button clicks se concurrent race ya data isolation poori verify nahi hoti. Ye sab **staging/test database** mein karein:

- [ ] Random invalid Shop ID se portal kholein; shop info/order submit nahi hona chahiye.
- [ ] Ek shop ko Super Admin se lock karein aur expiry date past wali disposable shop banayein; customer public portal order block kare. Phir test shop unlock/extend karein.
- [ ] Shop A admin se Shop B ke order ID, document URL, settings aur agent job endpoint hit karein; doosre tenant ka record/document nahi milna chahiye.
- [ ] Galat Super Admin/Shop Admin password par 401; correct account par login; logout ke baad protected API sign-in maange.
- [ ] PDF/JPG/PNG supported upload; unsupported `.docx`, text file ko `.pdf` rename, malformed PDF aur size limit se bada test file bhejein. Wrong content/oversized files reject hon aur private storage public URL na bane.
- [ ] Out-of-range page ranges, zero/negative/too-many copies aur unsupported paper option try karein; API reject kare; server quote hi final amount ho.
- [ ] Cash order ko confirm se pehle agent jobs poll karke dekhein: us order ka job nahi aana chahiye. Reject/cancel ke baad bhi queue nahi banna chahiye.
- [ ] UPI pending order ko admin verify karne se pehle queue mein nahi aana chahiye; wrong shop admin se verify reject hona chahiye; correct shop staff verification ke baad sirf ek job aaye. Customer reference optional ho to no-reference case bhi test karein.
- [ ] Customer upload token expiry ka test test DB mein expiry ko test setup se past karke karein; doosri shop ke upload token se order create na ho. Hourly cleanup test karein ki unclaimed expired file remove ho, order-bound file approved retention policy se pehle na mite.
- [ ] Agent ke do concurrent poll requests staging par bhejein; ek job do baar claim na ho. Lease timeout, max retry, failed job aur uncertain/duplicate print recovery simulate karein.
- [ ] Staging par login/upload/order/agent endpoints ko controlled rapid requests bhejkar dekhein normal customer flow unaffected rahe aur abusive burst limit ho. Current request limits review karein; risk ho to route-specific throttling/control add karke tests karein. Production ko load-test na karein.
- [ ] Shop price order banne ke baad change karke verify karein purane order ka saved price/config snapshot wahi rahe.
- [ ] Photo sheet ka generated PDF kholkar pages, dimensions, orientation, 1 cm margin, 2 mm gap aur cut guides inspect karein; actual printer par dummy photo test karein.
- [ ] `npm audit` output review karein. Severe/production-relevant issue ho to dependency/source update karke tests repeat karein; blind force-upgrade na karein.

Project ke `npm run smoke` mein auth, tenant, pricing, payment, queue/agent aur expiry/lock checks ka ek subset hai. Upar ke saare negative/concurrent/hardware cases automatically covered hone ka daawa nahi hai. Jo behavior app/API se verify nahi hota, uske liye engineering task/test add karein aur result record karein.

### G. Release commands aur logs

Local/staging PowerShell project root se:

```powershell
npm test
python -m unittest discover -s agent -p '*test*.py'
```

Smoke test sirf disposable staging/test DB par:

```powershell
$env:SMOKE_URL='https://YOUR-STAGING-SERVICE.onrender.com'
npm run smoke
```

Is command ko tabhi chalayein jab us service ka server staging/test `DATABASE_URL` use karta ho. Sirf URL staging dena enough nahi agar staging server galti se production DB se juda hai. Isliye Render staging Environment mein database alag confirm karein.

Logs mein password, JWT, agent token, UPI secret, ya customer file content nahi aana chahiye. Staging dependencies/security alerts dekhne ke liye `npm audit` chalayein; output aaye to production deploy se pehle direct/indirect dependency ka risk review karein. Har audit warning ko bina samjhe package upgrade karke production mein na bhejein.

### H. Local workspace ki safai

1. Project root par yeh **sirf listing** command chalayein; yeh file delete nahi karti:

   ```powershell
   Get-ChildItem -Force .test-postgres, storage, agent
   ```

2. `.test-postgres` agar ho to woh local test database files rakh sakta hai. `storage` mein upload/order files ho sakti hain. `agent` mein `config.json`, SQLite state aur log ho sakte hain. Pehle har filename/date/type pehchanein; app data pehchane bina delete na karein.
3. `agent/config.json` mein token hai; repository par kabhi stage na ho. `.env` local DB/admin secret file hai; usse cleanup/zip/GitHub mein include na karein.
4. Agar koi disposable smoke-test file confirm ho, usko app ke normal test cleanup procedure se hi remove karein; database/storage files ko random SQL/recursive delete se na saaf karein.
5. `.gitignore` aur Git status dobara check karein:

   ```powershell
   git status --short
   git check-ignore -v .env agent/config.json storage/test-upload.pdf
   ```

---

## 13. Error aaye to yeh pehle check karein

| Problem | Pehla check / exact action |
|---|---|
| `localhost:3000` nahi khul raha | PowerShell `cd D:\Code\Projects\Printing`, phir `npm start`; terminal ka error dekhein. `/api/health` check karein. |
| `port 3000 already in use` | Browser mein app pehle se open hai ya nahi dekhein. Extra Node process blindly kill na karein. |
| Database connection refused | PostgreSQL service Windows **Services** mein running? `.env` `DATABASE_URL` host/port/db/user/password correct? pgAdmin se same `printing_platform` connect karke dekhein. |
| `pgcrypto`/permission error | PostgreSQL Query Tool mein `printing_platform` select hai? Admin/user owner sahi? `CREATE EXTENSION IF NOT EXISTS pgcrypto;` us database mein run karein. |
| Super Admin login 401 | `.env`/Render ka `SUPER_ADMIN_EMAIL`/`SUPER_ADMIN_PASSWORD` exact use? Render env badalne ke baad redeploy hua? Password guess/default mat karein. |
| `/admin` par galat screen | Direct exact path `http://localhost:3000/admin` ya `PUBLIC_URL/admin`; refresh. Shop Admin email/password use karein, Super Admin ka nahi. |
| Shop portal unavailable | URL mein exact shop ID? Super Admin mein status locked/expired? Details/Extend/Unlock. Host `APP_URL` correct HTTPS hai? |
| QR galat/localhost dikha raha hai | Render `APP_URL` exact public HTTPS root, no trailing slash; env save/deploy karein; phir naya shop QR generate karein. |
| Customer upload fail | File PDF/JPG/PNG? `MAX_UPLOAD_MB` limit? Render persistent disk `UPLOAD_DIR` exact path par mounted? Disk full? Server logs check. |
| Price galat | Super Admin → shop row → **Details** → **Edit shop** → each rate/print option; duplex sheets rule owner se verify; new quote/order ke saath retest. |
| UPI app nahi khuli | Phone mein UPI app installed? Site usi phone par HTTPS/reachable host se open? Android/iOS browser app link ko allow karta hai? Order result page ka **Pay Online · Open UPI app** fallback tap karein. Desktop `localhost` par mobile app launch expected nahi. |
| UPI status pending | Manual mode mein staff ko apne UPI account mein payment dekhkar Admin order desk se verify karna hai. Return-to-browser success proof nahi. |
| Order queue mein nahi | Cash order par Confirm cash? UPI par exact received payment ke baad Verify UPI receipt? Customer order abhi pending ho sakta hai; Admin order row inspect. |
| Agent offline/unauthorized | Shop ID/server URL/token match? `agent/config.json` correct shop? Token rotate kiya to config update/restart? Shop Admin → **Shop settings** heartbeat dekhein. |
| Print command fail | Agent terminal/log mein OS command error. Windows par Linux `lp` command copy na karein; driver, printer name, PDF command flags/placeholders test. |
| Duplicate/uncertain physical print | Agent/app status dekhkar blindly retry na karein. Printer queue aur output tray inspect, operator se confirm, phir retry. |
| Render deploy failed | Web Service → **Events/Deploys** aur **Logs**. `DATABASE_URL`, `JWT_SECRET` length, `APP_URL`, disk path, Node version, same DB/service region check. Secret values kisi ko share na karein. |
| Deploy ke baad uploaded file gayab | Service mein persistent disk attached thi? Disk mount path aur `UPLOAD_DIR` match? Existing file backup restore planning karein; ephemerally lost file automatically wapas nahi aati. |

Error report share karna ho to error text aur relevant timestamp bhejein, lekin `.env`, password, database URL, JWT, UPI PIN, agent token, customer PDF/photo kabhi na bhejein.

---

## 14. Launch-completion sheet — print karke fill karein

### Platform owner

- Production service URL: `____________________________________________`
- Production database name/Render resource: `_____________________________`
- Disk mount path and size: `____________________________________________`
- Backup owner + schedule: `_____________________________________________`
- Restore rehearsal date/result: `________________________________________`
- Super Admin credential password manager mein saved: `[ ] yes`
- Customer document retention duration approved: `__________________________`
- Payment mode: `[ ] manual bank/UPI check`  `[ ] gateway work completed`
- Incident/operator contact: `____________________________________________`

### Har dukaan ke liye ek copy fill karein

- Shop name/ID: `_______________________________________________________`
- Owner approved name/contact/address: `[ ]`
- Shop Admin credentials owner ko secure channel se mile: `[ ]`
- Rate card owner ne verify kiya: `[ ]`
- Duplex billing formula owner ne approve ki: `[ ]`
- UPI ID/payee owner se test/verify hua: `[ ]` (UPI enabled ho to)
- Allowed sizes/types/color/duplex/photo actual printer ke hisaab se: `[ ]`
- QR correct domain/shop par khulta hai: `[ ]`
- Agent recent heartbeat: `[ ]`
- Physical test outputs inspect hue: `[ ]`
- Failed/uncertain retry process staff ko pata: `[ ]`
- Customer payment instruction aur manual verification procedure owner ko pata: `[ ]`

### Launch ko “ready” kab likhein

Live shop tabhi customers ke liye ready mark karein jab production URL/HTTPS, database, disk, backup/restore plan, exact shop details/rates/UPI, Shop Admin login, agent/printer test, payment verification procedure aur retention policy ka decision sab recorded ho. Agar ek bhi physical printer test ya payment account verify nahi hua, us feature ko customer-facing enabled na rakhein.

---

## Official provider help pages

Dashboard buttons/plans kabhi badal sakte hain; agar is guide ka button label Render/GitHub page par thoda alag ho to official current help page follow karein:

- [Render: Node/Express Web Service deploy](https://render.com/docs/deploy-node-express-app)
- [Render: Web Services and advanced settings](https://render.com/docs/web-services)
- [Render: environment variables](https://render.com/docs/configure-environment-variables)
- [Render: Persistent Disks](https://render.com/docs/disks)
- [Render: create/connect PostgreSQL](https://render.com/docs/postgresql-creating-connecting)
- [Render: database backup/recovery](https://render.com/docs/postgresql-backups)
- [GitHub: local existing project ko GitHub par push karna](https://docs.github.com/en/migrations/importing-source-code/using-the-command-line-to-import-source-code/adding-locally-hosted-code-to-github)
- Project ke apne notes: [README.md](README.md), [ENVIRONMENT.md](docs/ENVIRONMENT.md), [DEPLOYMENT.md](docs/DEPLOYMENT.md), [PRINT_AGENT.md](docs/PRINT_AGENT.md), [API.md](docs/API.md), aur [REMAINING_WORK.md](REMAINING_WORK.md).
