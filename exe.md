# SAS Smart PWA — Sıfırdan Yeniden İnşa Şartnamesi

Bu belge, uygulamayı **sıfırdan** (ör. Node.js + paketlenmiş `.exe`) yeniden yazacak bir
geliştirici/ajan içindir. Mevcut uygulamanın **tüm** özelliklerini, iş kurallarını ve
backend API ayrıntılarını içerir. Hedef: SAS Smart Suite (restoran POS) için **mobil öncelikli
PWA** — garson/kasiyer telefon/tabletten adisyon açar, ürün ekler, sipariş kaydeder; kasiyer
rapor görür ve menüyü yönetir.

> Veritabanına **doğrudan bağlanılmaz**. Her şey SAS'ın HTTP API'si (`SASncps`) üzerinden yapılır.

---

## 1. Mimari

```
[ Telefon / PWA (tarayıcı) ] → HTTPS → [ Node.js BFF/proxy ] → HTTP → [ SAS sunucusu :8081 ]
```

- **Node sunucu** hem statik PWA'yı sunar hem de `/api/*` altında SAS'a giden bir köprüdür.
- SAS'ın sabit `SasUsername/SasPasswd` header'ları **yalnızca sunucuda** eklenir, tarayıcıya sızmaz.
- Oturum yönetimi, doğrulama, yetki kontrolü, fiyat güvenliği sunucuda yapılır.
- İstemci bağımlılıksız **vanilla JS** (build adımı yok) olabilir; sunucu tek bağımlılık olarak
  Express kullanır. (İsterseniz başka yığınla da yazılabilir; davranış aynı kalmalı.)

### Dosya düzeni (öneri)
```
server.js         Express: oturum, doğrulama, /api rotaları, statik dosyalar, sürüm
lib/sas.js        SAS istemcisi + yanıt zarfı çözümü + DTO dönüştürücüleri
lib/mock.js       SAS_MOCK=1 için sahte SAS (demo/test)
public/           PWA: index.html, app.js, styles.css, sw.js, manifest.webmanifest, fonts/, icons/
data/             Çalışma anında yazılan JSON'lar (gizli ürün/kategori, yarım porsiyon ayarı)
test/             API testleri (node:test)
```

---

## 2. Yapılandırma (ortam değişkenleri)

| Değişken | Açıklama | Varsayılan |
|---|---|---|
| `SAS_HOST` | SAS sunucusu IP/alan adı (yalnızca host) | — (zorunlu) |
| `SAS_PORT` | SAS portu | `8081` |
| `SAS_USERNAME` | SAS sabit header `SasUsername` | — (ör. `root`) |
| `SAS_PASSWD` | SAS sabit header `SasPasswd` | — (ör. `1234`) |
| `PORT` | Node sunucu portu | `3000` |
| `TRUST_PROXY` | HTTPS reverse proxy arkasındaysa `1` (çerez `Secure` olur) | kapalı |
| `SESSION_HOURS` | Oturum süresi (saat) | `12` |
| `SAS_TIMEOUT_MS` | SAS istek zaman aşımı (ms) | `8000` |
| `SAS_MOCK` | `1` → gerçek SAS yerine sahte veri (demo/test) | kapalı |
| `SAS_BAHCE_TABLES` | Bahçe sayılacak masa numaraları (Salon'dan ayrılır) | `1-15,51` |
| `SAS_REPORT_MAX_AUTH` | Raporları görebilen en yüksek yetki (auth) | `13` |
| `SAS_TABLE_COUNT` | Her bölümdeki masa sayısı | `72` |
| `SAS_LOGIN_USERS` | Giriş ekranında seçilebilecek adlar (virgülle; boşluk serbest) | boş |
| `DATA_DIR` | `data/` klasörünün yolu | `./data` |

URL deseni ve header'lar: `.env` bilgilerini sohbet/commit'e koymayın; örnek dosya `.env.example`.

---

## 3. SAS Backend API (`SASncps`) — tam referans

SAS'ın API'si, masaüstü POS programının içinde .NET `HttpListener` ile yayınlanır:
`http://<SAS_HOST>:<SAS_PORT>/SASncps/`. **POS açık ve connector çalışır değilse API de çalışmaz.**

### İstek biçimi
```
GET/POST  http://{host}:{port}/SASncps/@Action/<ACTION>!?<param=değer&...>
Header:   SasUsername: <SAS_USERNAME>
          SasPasswd:  <SAS_PASSWD>
POST'ta:  Content-Type: application/json   (gövde = ürün dizisi)
```
- `@Action/` sabit yol parçası, `<ACTION>` metodun adı, `!` sabit ayraç, ardından `?query`.
- Parametre değerleri URL-encode edilir.

### Yanıt zarfı
```json
{ "Result": "true"|"false", "Data": [ ... ], "Message": "..." }
```
- `Result` **string** gelebilir (`"true"`/`"false"`) — bool gibi değerlendirin (`"true"`, `true`, `1` → başarılı).
- Liste endpoint'lerinde `Data` bir dizidir. Bazı .NET servisleri JSON'u string içine sarabilir;
  `Data` string ve `[`/`{` ile başlıyorsa bir kez daha parse edin.
- Alan adları karışık büyük/küçük harf olabilir → **büyük/küçük harfe duyarsız** okuyun.
- Tanınmayan action'a sunucu düz metin `Diger Talepler` döndürür (zarf değil) → "yok" sayın.

### Endpoint'ler

| Action | Metot | Parametreler | İşlev / dönen veri |
|---|---|---|---|
| `Auth` | GET | `cc`, `un`, `pw` | Giriş. `cc` = şube `secid`. Dönen: `{id, name, auth}`. Yalnızca `smartlogin=1` kullanıcılar girer. Şifre düz metin. |
| `Branch` | GET | `auth` (sabit `22`) | Şubeler: `{id, secid, shortcode, ip}`. |
| `Fields` | GET | — | Bölümler: `{id, name}`. **Yalnızca `pda=1` bölümler gelir** (pratikte sadece "Salon"). |
| `MenuCat` | GET | — | Kategoriler: `{id, name}`. |
| `Product` | GET | `cat` | Ürünler: `{PrId, PrName, Price_s, P_Type}`. **`inuse` filtrelenmez** → pasif ürünler de gelir (önemli, aşağıda). |
| `TableStatus` | GET | `field` (ops.) | **Yalnızca açık** masalar/adisyonlar: `{Sid, TableId, TableName, Days, Hours, Minutes, TotalPrice, Discount, Usr, OpenDate}`. |
| `SalesDetails` | GET | `sid` | Adisyon satırları: `{Dsid, Sid, TableName, ProductName, UnitPrice, TotalPrice, Quantity, SalesDate}`. |
| `SalesPrint` | GET | `sid` | Adisyon/hesap fişi yazdır. |
| `Payments` | GET | `start`, `end` | Ödemeler: `{PayId, Sid, TableName, Days, Hours, Minutes, PayDate, TotalPrice, PayType, PayMethod, Usr, TableId}`. |
| `SalesReport` | GET | `start`, `end` | Satış özeti: `{Prid, Prname, Quantity, Mid}`. |
| `SaveSales` | POST | `fid, tid, sid, uid, uname, comm` + gövde | Sipariş kaydı. Gövde = `SrProducts[]` (aşağıda). Yeni masada `sid=0`. |
| `CheckState` | GET | — | Sağlık/ping: `{ "Result":"true" }`. |
| `CallerID` | GET | `ci` | Arayan numara (kullanılmıyor, opsiyonel). |
| `PackPrint` | GET | `sid` | Paket fişi (yalnız Paket Servis; bu uygulamada kullanılmaz). |
| `SenqronGorev` / `SenqronSales` | GET | — | Senkron (kullanılmaz). |

**Tarih formatı** (`start`/`end`): `yyyy-MM-dd HH:mm:ss`.

### DTO'lar (SAS alan adları)
```
Auth yanıtı:   { id, name, auth }                       // auth: yetki seviyesi (sayı/str)
Branch:        { id, secid, shortcode, ip }
Fields:        { id, name }
MenuCat:       { id, name }
Product:       { PrId, PrName, Price_s, P_Type }        // P_Type=2 → yarım porsiyon satılabilir
TableStatus:   { Sid, TableId, TableName, Days, Hours, Minutes, TotalPrice, Discount, Usr, OpenDate }
SalesDetails:  { Dsid, Sid, TableName, ProductName, UnitPrice, TotalPrice, Quantity, SalesDate }
Payments:      { PayId, Sid, TableName, Days, Hours, Minutes, PayDate, TotalPrice, PayType, PayMethod, Usr, TableId }
SalesReport:   { Prid, Prname, Quantity, Mid }
SaveSales gövdesi (her ürün): {
  PrId, PrName, Price_s, P_Type, Quantity, PrComment, TmpIndex, Price_t
}  // Price_t = Price_s * Quantity
```

---

## 4. İş kuralları (KRİTİK — hepsi korunmalı)

1. **Masalar — açık masalardan tam liste üretme.** `TableStatus` yalnızca **açık** masaları döndürür.
   Uygulama her bölüm için `1..SAS_TABLE_COUNT` (72) masayı kendisi üretir; açık olanları
   `TableId` (= masa numarası) ile eşleştirip tutar/süre ekler, gerisini "boş" gösterir.
   (Açık masa numarası `SAS_TABLE_COUNT`'tan büyükse o da listeye eklenir.)

2. **Bahçe / Salon ayrımı.** SAS tek "Salon" bölümü döndürür. `SAS_BAHCE_TABLES` (vars. `1-15,51`)
   masa numaraları **Bahçe** bölümüne, kalanı **Salon**'a ayrılır; her ikisi numara sırasıyla listelenir.
   (SAS zaten adında "Bahçe" geçen ayrı bir bölüm döndürüyorsa ayırma yapılmaz.)

3. **Yarım porsiyon.** `P_Type == 2` olan ürünler adet **0,5 adımlarla** satılabilir (0,5 / 1,5 ...).
   Diğerleri yalnızca tam sayı. Kasiyer bunu **kategori bazında** kapatıp açabilir
   (ayar dosyası `half-categories.json`: `id → "on"/"off"`). Ayar yoksa **varsayılan**: adı "dürüm"
   içeren kategoride **kapalı**, diğerlerinde açık. Sunucu, yarım satılamayan ürüne 0,5'li adet
   gelirse siparişi 400 ile reddeder.

4. **Gizli ürün/kategori (kasiyer).** SAS `Product` çağrısı `inuse`'a bakmaz → pasif ürünler ve
   kasada kullanılmayanlar ("Kurye Bedeli" gibi) mobile düşer. API bunu ayıklayamadığından kasiyer
   bunları elle gizler. Listeler sunucuda dosyada tutulur:
   - `hidden-products.json` (`ürün_id → ad`)
   - `hidden-categories.json` (`kategori_id → ad`)
   Gizli ürün/kategori sipariş ekranında ve aramada görünmez; gizli ürünle gelen sipariş reddedilir.

5. **Raporlar yalnızca kasiyere.** Kullanıcının `auth` değeri `SAS_REPORT_MAX_AUTH`'tan (vars. 13)
   **küçük/eşitse** kasiyer sayılır: Raporlar sekmesini ve Menü düzeni ekranını görür. Büyükse garson:
   yalnızca masa/sipariş. Sunucu hem sekmeyi gizler hem `/api/reports/*` ve yönetim rotalarını 403 yapar.

6. **Fiyat ve kullanıcı güvenliği.** Sipariş kaydında ürün **fiyatı ve adı istemciden alınmaz**;
   sunucu, menüden (önbelleğe alınmış `Product`) ürünü id ile bulup fiyat/ad/tip'i oradan koyar.
   `uid`/`uname` istemciden değil **oturumdan** gelir. İstemci yalnızca `{id, quantity, comment}` gönderir.

7. **Adisyon notu (`comm`).** Sepette masa geneli bir not alınır ve `SaveSales`'in `comm`
   parametresiyle gönderilir. Ürün bazlı not ayrıca `PrComment` ile her satıra yazılır.

8. **İş günü 06:00'da başlar.** Rapor tarih aralığı: `start` → `start 06:00:00`,
   `end` → `(end + 1 gün) 06:00:00` (yarı açık aralık). İstemcideki "bugün" de 06:00 öncesini
   önceki iş gününe sayar.

9. **Fiş yazdırma.** SAS, `SaveSales`'te fişi kendisi basar; mobil API'de bunu kapatan parametre
   yoktur. Bu yüzden "yazdırmadan kaydet" gibi bir seçenek **yoktur**; tek "Siparişi kaydet" vardır.
   Açık adisyonun hesabı için ayrı "Adisyonu yazdır" (`SalesPrint`) düğmesi vardır.

10. **Para biçimi.** `tr-TR`, iki ondalık, sembol sonda: `420,00 ₺`. Adetler `tr-TR` (`1,5`).

---

## 5. Node sunucu — `/api` rotaları

Tümü JSON. Durum değiştiren isteklerde (`POST`) **CSRF** için: `Origin` header'ı varsa host ile
eşleşmeli, yoksa 403. Yanıtlarda `Cache-Control: no-store`. Güvenlik başlıkları: CSP
(`default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`),
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`.

### Oturum
- Giriş başarılıysa `crypto.randomBytes(32)` token üretilir, bellek içi oturum haritasına yazılır,
  `Set-Cookie: sas_sid=<token>; HttpOnly; SameSite=Lax; Path=/; Max-Age=<SESSION_HOURS*3600>` (+`Secure` proxy'de).
- Oturum verisi: `{ uid, uname, auth, expires }`. Süresi geçeni periyodik temizle.
- Giriş hız sınırı: IP başına 5 dakikada 10 deneme; başarılı giriş sayacı sıfırlar.

### Rotalar
| Yol | Yetki | Davranış |
|---|---|---|
| `POST /api/login` `{cc, username, password}` | — | `Auth!` çağırır. Başarılıysa oturum açar, çerez verir. Dönüş: `{user:{id,name,auth,reports}}`. Hatalı → 401. |
| `POST /api/logout` | oturum | Oturumu siler, çerezi temizler. |
| `GET /api/me` | oturum | `{user:{id,name,auth,reports}}`. |
| `GET /api/login-users` | — | `SAS_LOGIN_USERS` dizisi (giriş ekranı için). |
| `GET /api/version` | — | `{version}` (aşağıda sürümleme). |
| `GET /api/branches` | oturum | `Branch!?Auth=22` → `[{id, secid, shortcode}]`. |
| `GET /api/fields` | oturum | `Fields!` → `[{id, fid, name, part?}]`. Salon'u Salon/Bahçe'ye bölebilir (bkz. iş kuralı 2). `id` string, `fid` gerçek SAS bölüm id'si, `part`∈`salon`/`bahce`. |
| `GET /api/tables?field=&part=` | oturum | `TableStatus!?field=`. Tam masa listesi üretir (iş kuralı 1). `part` verilirse Bahçe/Salon filtreler. `field` yoksa yalnız açık adisyonlar. Dönüş: `[{sid, tableId, no, tableName, totalPrice, days, hours, minutes, user, openDate}]`. |
| `GET /api/categories` (`?all=1`) | oturum (all=kasiyer) | `MenuCat!`. Normalde gizli kategoriler çıkarılır. `all=1` (kasiyer): hepsi + `{hidden, half}`. |
| `POST /api/categories/:id/hidden` `{hidden:bool}` | kasiyer | Kategori gizle/göster. |
| `POST /api/categories/:id/half` `{half:bool}` | kasiyer | Kategoride yarım porsiyonu aç/kapat. |
| `GET /api/products?cat=` (`?all=1`) | oturum (all=kasiyer) | `Product!?cat=`. Gizli ürünler/gizli kategoriler çıkarılır; her ürüne `half` (yarım satılabilir mi) eklenir. `all=1`: hepsi + `{hidden}`. |
| `POST /api/products/:id/hidden` `{hidden:bool}` | kasiyer | Ürün gizle/göster. |
| `GET /api/sales/:sid` | oturum | `SalesDetails!?sid=` → `[{dsid, productName, quantity, unitPrice, totalPrice, salesDate}]`. |
| `POST /api/sales/:sid/print` | oturum | `SalesPrint!?sid=`. |
| `POST /api/orders` `{fid, tid, sid, comm?, items:[{id, quantity, comment}]}` | oturum | Doğrular, gizli ürün/yarım kuralını uygular, fiyatları menüden alır, `uid/uname` oturumdan → `SaveSales!`. `sid=0` yeni adisyon. |
| `GET /api/reports/payments?start=&end=` | kasiyer | `Payments!`, iş günü aralığı. |
| `GET /api/reports/sales?start=&end=` | kasiyer | `SalesReport!`, iş günü aralığı. |

Doğrulama: id/sayı parametreleri tamsayı ve sınırlar içinde; adet `>0`, `≤999`, `×2` tamsayı (0,5 adım);
sepet 1–200 kalem; notlar ≤200 char. Hatalı → 400. SAS hataları → anlamlı mesajla 4xx/5xx.

### Statik sunum + sürümleme
- `GET /` ve `/index.html`: `index.html` içindeki `__V__` yer tutucuları çalışma anındaki sürümle
  değiştirilir, `Cache-Control: no-store`.
- Diğer statikler `no-cache`; `app.js`/`styles.css` **sürümlü** URL ile gömülür: `/app.js?v=<sürüm>`.
- Sürüm = `package.json` sürümü + dosya boyut/zaman özetinden kısa hash: ör. `1.8.0-ab12cd3`.
- `GET /api/version` bu sürümü döndürür. İstemci açılışta ve öne gelince kıyaslar, farklıysa
  önbelleği temizleyip yeniden yükler.

---

## 6. İstemci (PWA) — ekranlar ve davranış

Tek sayfa, bağımlılıksız. Alt menü (tab bar): **Masalar · Raporlar(kasiyer) · Ayarlar**.
(Mutfak sekmesi YOK.) Her ekran değişiminde geç gelen yanıtları yok saymak için bir `nav` sayacı tut.

### 6.1 Giriş
- Alanlar: **Müşteri kodu**, **Kullanıcı adı**, **Şifre**. `cc` ve son kullanıcı adı cihazda hatırlanır.
- **Kullanıcı seçimi:** `GET /api/login-users` + cihazda daha önce girenler, düğme (chip) olarak.
  Birine dokununca kullanıcı adı dolar, imleç şifreye gider. Boşluklu adlar desteklenir.
- Giriş başarılıysa Masalar'a geçer; hatalıysa alan altında mesaj.

### 6.2 Masalar
- Üstte **bölüm çipleri** (Salon, Bahçe, …). Seçili bölüm hatırlanır.
- Altında **filtre**: `Tümü N` / `Dolu N` / `Boş N` (segmented).
- **Masa ızgarası:** satıra ~4 masa. Her masa: büyük **numara**; doluysa yeşil arkaplan +
  **tutar** + süre (ör. `1sa 22dk`), boşsa "Boş". Dokununca sipariş ekranı.
- **20 sn'de bir** sessiz yenilenir (sekme görünürken).

### 6.3 Sipariş ekranı (viewOrder)
- Mavi üst çubuk: başlık **"Satış: <masa adı>"**, sağda **"N ÜRÜN EKLENDİ"** sayacı.
- İki büyük düğme: **KATEGORİ** (kategori seç alt sayfası) ve yanında **seçili kategori adı**.
- **Arama kutusu:** tüm menüde arar (gerekirse tüm kategorileri bir kez yükler).
- **Ürün listesi:** her satır — ürün adı solda, fiyat sağda. Satıra dokunmak **+1** ekler.
  Yarım satılabilen üründe ayrıca **+½** düğmesi. Eklenen üründe solda yeşil **adet rozeti**
  (`1`, `1,5`…) ve sağda **−** düğmesi (yarımda 0,5 azaltır). Ürün eklenince hafif titreşim (varsa).
- Alt bar: **VAZGEÇ** (sepette ürün varsa onay sorar, temizler, geri döner) ve **SİPARİŞİ BİTİR**
  (sepet alt sayfasını açar). Sayaç 0 iken ikisi de pasif.
- **Açık adisyonda** ayrıca **Menü / Adisyon** segmented. "Adisyon": `SalesDetails` satırları +
  toplam + **"Adisyonu yazdır"** (`/sales/:sid/print`).

### 6.4 Sepet (alt sayfa / dialog)
- Her kalem: ad, `fiyat × adet = tutar`, stepper (−/adet/+; yarımda 0,5), ve bir **ürün notu** alanı.
- En altta **Adisyon notu** alanı (tek, masa geneli → `comm`).
- **Toplam** ve **Siparişi kaydet**. Kayıt: `POST /api/orders`. Başarılı → sepet temizlenir,
  "Sipariş kaydedildi" bildirimi, Masalar'a döner. Sepet ve notlar cihazda (localStorage) saklanır,
  masa bazında (`cart:<tableId>`), böylece kaza ile kapanırsa kaybolmaz.

### 6.5 Raporlar (yalnız kasiyer)
- Tarih aralığı (başlangıç/bitiş, bugün varsayılan, iş günü 06:00 mantığı).
- **Ödemeler / Satışlar** (segmented).
  - Ödemeler: ödeme türüne göre özet kutuları (Nakit/Kredi…) + liste.
  - Satışlar: ürün bazında adet, en çoktan aza, çubuk (bar) ile.

### 6.6 Ayarlar
- **Profil:** ad, `Kasiyer`/`Garson`, `No: <id>`, `Yetki: <auth>`.
- **Görünüm** (cihazda saklanır, CSS değişkenleriyle uygulanır):
  - Yazı büyüklüğü: Küçük/Normal/Büyük/Çok büyük (kök `font-size`).
  - Yazı kalınlığı: Normal/Orta/Kalın.
  - Yazı tipi: Sistem / Inter / Nunito / Serif / Eş aralıklı (Inter & Nunito gömülü woff2).
  - Canlı önizleme kartı + "Varsayılana dön".
- **Menü düzeni** (yalnız kasiyer): "Düzenle" → Ürünler / Kategoriler sekmeleri.
  - Ürünler: kategori seç, her ürün yanında **Gizle/Göster**.
  - Kategoriler: her kategori yanında **Gizle/Göster** ve **½ Açık / ½ Kapalı** (yarım porsiyon).
- **Şubeler:** `/api/branches` listesi.
- **Uygulama:** sürüm no + **Güncelle** düğmesi (önbellek temizle + yeniden yükle).
- **"Uygulamayı ana ekrana ekle"** (beforeinstallprompt yakalanırsa).
- **Çıkış yap.**

### 6.7 Çevrimiçi/çevrimdışı ve güncelleme
- Çevrimdışıyken üstte uyarı şeridi; `online/offline` olaylarını dinle.
- Service worker: uygulama kabuğunu önbelleğe alır (**önce ağ, sonra önbellek**), `/api/*`'e dokunmaz.
  Böylece bağlantı yokken uygulama yine açılır. Sürüm değişince eski önbellek temizlenir.
- İstemci `/api/version` ile sunucu sürümünü kıyaslar; farklıysa **otomatik** sert yeniden yükleme
  (aynı sürüm için en çok bir kez).

---

## 7. Görünüm / tema

- Ana renk mavi (POS ekranına benzer). Örnek tokenlar (CSS `:root`):
  `--bar:#3b74d1` (üst çubuk), `--accent:#2f62c4`, `--go:#3a7d22` (yeşil/kaydet),
  `--stop:#e8562a` (turuncu/vazgeç), açık masa yeşili `--open:#c6f3c6`, çizgi/yüzey nötr gr/beyaz.
- **Koyu tema** `@media (prefers-color-scheme: dark)` ile; `body`'ye açık arka plan ver.
- Mobilde: 16px yan boşluk, yatay kaydırma yok, dokunmatik hedefler ≥44px, `safe-area-inset` payları.
- Para/adet tabular-nums. Büyük masa numaraları okunaklı.

---

## 8. Demo / test (SAS olmadan)

- `SAS_MOCK=1` iken `lib/mock.js` gerçek SAS zarfını taklit eder. Giriş: kasiyer `demo/demo/demo`
  (auth 1), garson `demo/garson/garson` (auth 14). Tek bölüm "Salon", gerçek sunucu gibi **yalnızca açık**
  masaları döndürür; kategoriler (Kebaplar yarım tipinde), ürünler, birkaç açık adisyon, ödeme/satış örnekleri.
- `node:test` ile API testleri: giriş akışı, zarf çözümü, URL deseni (`@Action/`, `!`), oturum koruması,
  yetki (garson rapor göremez), masa tam listesi, Bahçe/Salon ayrımı, yarım porsiyon kuralı,
  gizli ürün/kategori, adisyon notu (`comm`), doğrulama hataları, CSRF.

---

## 9. `.exe` olarak paketleme

- Node uygulaması `pkg` veya `nexe` ile tek `.exe` yapılabilir. `public/` ve varsayılan `data/`
  gömülmeli ya da exe yanına kopyalanmalı; `DATA_DIR` yazılabilir bir klasöre işaret etmeli.
- Exe açılınca `PORT`'ta dinler; restoran ağındaki SAS sunucusuna (`SAS_HOST:8081`) erişebilmeli.
- Telefonlar `http://<exe-makinesi-ip>:<PORT>`'a bağlanır. **PWA kurulumu/çevrimdışı için HTTPS
  gerekir** (localhost hariç) → exe'yi bir reverse proxy (Caddy/nginx) arkasında HTTPS ile yayınlayın
  ve `TRUST_PROXY=1` verin. Ayarlar `.env` veya exe yanındaki bir yapılandırma dosyasından okunmalı.
- Oturumlar bellekte; tek instance çalıştırın (yeniden başlatınca kullanıcılar tekrar girer).

---

## 10. Kabul ölçütleri (özet)

1. Garson giriş → bölüm (Salon/Bahçe) → masa → kategori/arama → ürün ekle (gerekirse +½) →
   sepet (ürün notu + adisyon notu) → **Siparişi kaydet** → masa dolu görünür, tutar doğru.
2. Açık masada **Adisyon** sekmesi satırları ve **Adisyonu yazdır** çalışır.
3. Pasif/istenmeyen ürün ve kategoriler kasiyer tarafından gizlenebilir; herkes için geçerli olur.
4. Dürüm kategorisinde +½ çıkmaz; kasiyer başka kategoride de aç/kapat yapabilir.
5. Raporlar yalnızca kasiyerde; garson ne sekmeyi ne de API'yi görür.
6. Fiyatlar ve kullanıcı bilgisi istemciden gelmez; gizli üründe sipariş reddedilir.
7. Yazı büyüklüğü/kalınlığı/tipi değişir ve cihazda kalır.
8. Çevrimdışı açılır; sürüm değişince uygulama kendini günceller.
9. Paket Servis/Mutfak **yok** (SAS API'de pda filtresi nedeniyle paket gelmez).
