# SAS Smart Suite – Mobil Uygulama API Dökümantasyonu

> Bu döküman, `b0f70bc3-base.apk` (SAS Smart Suite POS/adisyon uygulaması) dosyasının
> tersine mühendislik (reverse engineering) ile çözümlenmesiyle oluşturuldu.
> Amaç: Node.js ile **web tabanlı** yeni bir mobil arayüz geliştirmek için backend
> API'sinin tam olarak nasıl çağrıldığını belgelemek.

---

## 1. Genel Bakış

| Özellik | Değer |
|---|---|
| Uygulama | SAS Smart Suite (restoran/adisyon POS) |
| Paket adı | `com.sas.SAS_Smart` |
| Teknoloji | **Xamarin.Forms** (.NET / Mono) — asıl kod `assemblies/SASSmart.Droid.dll` içinde |
| HTTP istemcisi | `System.Net.Http.HttpClient` |
| JSON | Newtonsoft.Json (`JsonConvert`) |
| Geliştirici (pdb yolu) | `/Users/serkansever/Projects/SASSmart/...` |

Uygulama bir **restoran adisyon/sipariş yönetim** programıdır. Ekranlar:
Login → Şube/Bölüm/Masa seçimi → Ürün ekleme → Sipariş kaydetme, ayrıca
Bekleyen/Hazırlanıyor/Hazır (mutfak ekranı), Ödemeler ve Satış Raporu.

---

## 2. Temel URL Yapısı (ÇOK ÖNEMLİ)

Uygulama, login ekranında girilen **sunucu adresinden** şu şablonu oluşturur:

```
TmpServer = "http://" + {girilen_sunucu} + ":8081/SASncps/@Action/"
```

Sizin verdiğiniz adres bununla birebir uyuşuyor:
`http://88.247.51.116:8081/Sasncps` → sunucu alanına **`88.247.51.116`** girilmiş.

Her istekte nihai URL şöyle kurulur (decompile edilmiş `ServiceManager` kodundan):

```
url = string.Format( string.Concat(TmpServer, action, params), "" )
    = "http://88.247.51.116:8081/SASncps/@Action/" + <ACTION><PARAMS>
```

Yani tam URL deseni:

```
http://88.247.51.116:8081/SASncps/@Action/<ACTION>!<?query...>
```

- `@Action/` **gerçek bir sabit yol parçasıdır** (string'de `{0}` yoktur, `@Action` aynen gider).
- `<ACTION>` metodun adıdır (örn. `Auth`, `Product`, `SaveSales`).
- `!` karakteri action adının hemen ardına gelen **sabit bir ayraçtır**.
- `?` ile query string başlar.

> Not: Sunucu büyük/küçük harfe duyarsız görünüyor (`SASncps` ~ `Sasncps`).

---

## 3. Sabit HTTP Header'ları (TÜM isteklerde gönderilir)

`ServiceManager.GetClient()` her `HttpClient`'a şu header'ları ekliyor:

```
SasUsername: root
SasPasswd: 1234
```

- Timeout: **5 saniye**
- `MaxResponseContentBufferSize` ayarlı
- POST isteklerinde `Content-Type: application/json`

> ⚠️ **Güvenlik notu:** `root` / `1234` kimlik bilgileri APK içine **gömülü (hardcoded)**.
> Bu, sunucu tarafının basit bir header kontrolü yaptığını gösterir. Yeni sistemi
> kurarken bunları mutlaka değiştirin / düzgün bir kimlik doğrulama ekleyin.

---

## 4. Yanıt Zarfı (Response Envelope)

Sunucu, tüm GET/POST yanıtlarını şu zarf içinde döndürür
(`DeserializeObject<SasResult<T>>`):

```json
{
  "Result":  <bool/int>,       // başarı durumu
  "Data":    <veri>,           // asıl veri: liste endpoint'lerinde JSON dizisi
  "Message": "<mesaj>"         // hata/bilgi mesajı
}
```

- Liste döndüren endpoint'lerde `Data` bir **JSON dizisidir** (aşağıdaki DTO'ların dizisi).
- `Auth`, `Branch` gibi tekil endpoint'lerde `Data` tek nesne veya tek elemanlı olabilir.

---

## 5. Kimlik Doğrulama (Login) Akışı

Login ekranı 4 alan içerir: `txtServer`, `txtCustomerCode`, `txtUser`, `txtPassword`.
Bunlar `Settings` içine kaydedilir (CustomerCode, Username, Password, Server).

### 5.1. Auth (giriş)
```
GET http://{host}:8081/SASncps/@Action/Auth!?cc={customerCode}&un={username}&pw={password}
```
- **Dönüş DTO:** `SrLoginEntries` → `{ id, name, auth }`
- Dönen `id` → sonraki isteklerde `uid` (TmpUid) olarak kullanılır.
- Dönen `name` → `uname` (TmpUsername) olarak kullanılır.

### 5.2. Branch (şube listesi)
```
GET http://{host}:8081/SASncps/@Action/Branch!?Auth=22
```
- `Auth=22` değeri binary'de **sabit** gömülü (literal).
- **Dönüş DTO:** `SrBranch` → `{ id, secid, shortcode, ip }`
- Seçilen şubenin bilgisi `TmpServer`'ı güncelleyebilir (şubenin kendi IP'si varsa).

---

## 6. Tüm Endpoint'ler

Aşağıda `action + params` kısmı verilmiştir. Başına daima
`http://{host}:8081/SASncps/@Action/` eklenir. Query parametre değerleri `{...}` ile gösterildi.

| # | İşlev | Metot | Action + Parametre | DTO (Data) |
|---|---|---|---|---|
| 1 | Giriş | GET | `Auth!?cc={cc}&un={un}&pw={pw}` | `SrLoginEntries` |
| 2 | Şubeler | GET | `Branch!?Auth=22` | `SrBranch` |
| 3 | Bölümler (salon alanları) | GET | `Fields!` | `SrFields` |
| 4 | Masa durumları | GET | `TableStatus!?field={fieldId}` | `SrOpenTables` |
| 5 | Aktif masalar / açık adisyonlar | GET | `TableStatus!` | `SrOpenTables` |
| 6 | Ürün kategorileri | GET | `MenuCat!` | `SrMenuCat` |
| 7 | Kategorideki ürünler | GET | `Product!?cat={catId}` | `SrProducts` |
| 8 | **Sipariş kaydet** | **POST** | `SaveSales!?fid={fid}&tid={tid}&sid={sid}&uid={uid}&uname={uname}` | gövde: `SrProducts[]` |
| 9 | Adisyon detayları | GET | `SalesDetails!?sid={sid}` | `SrSalesDetails` |
| 10 | Adisyon yazdır | GET | `SalesPrint!?sid={sid}` | `SrProducts[]` |
| 11 | Bekleyen siparişler (mutfak) | GET | `Bekleyen!` | `SrBekleyen` |
| 12 | Hazırlanıyor | GET | `Hazirlaniyor!` | `SrBekleyen` |
| 13 | Hazır | GET | `Hazir!` | `SrBekleyen` |
| 14 | Ödemeler raporu | GET | `Payments!?start={start}&end={end}` | `SrPayments` |
| 15 | Satış raporu | GET | `SalesReport!?start={start}&end={end}` | `SrSalesReport` |

**Tarih formatı** (`start` / `end`): `yyyy-MM-dd 06:00:00`
(iş günü sabah 06:00'da başlıyor; örn. `2026-11-15 06:00:00`).

---

## 7. Sipariş Girme Akışı (Detaylı) — Ana Hedef

Mobilden sipariş girerken izlenen adımlar ve atılan istekler:

1. **Login** → `Auth!?...` → `uid` (id) ve `uname` (name) alınır.
2. **Şube seç** → `Branch!?Auth=22`
3. **Bölüm seç** → `Fields!` → `fid` (seçilen bölüm id'si = `CurrentField`)
4. **Masa seç** → `TableStatus!?field={fid}` → `tid` (TableId). Masa açıksa mevcut `sid` gelir, yeni masa ise `sid=0`.
5. **Kategori seç** → `MenuCat!`
6. **Ürün listele** → `Product!?cat={catId}`
7. **Ürün ekle** → kullanıcı ürünleri yerel listeye (`TmpSales`) ekler; adet +/- (`btnPlus`/`btnMinus`), silme (`btnRemove`), not (`PrComment`).
8. **Kaydet** → aşağıdaki POST atılır:

```
POST http://{host}:8081/SASncps/@Action/SaveSales!?fid={fid}&tid={tid}&sid={sid}&uid={uid}&uname={uname}
Content-Type: application/json
SasUsername: root
SasPasswd: 1234

[
  {
    "PrId":     123,          // ürün id
    "PrName":   "Adana Dürüm",
    "Price_s":  150.00,       // birim/satış fiyatı
    "P_Type":   0,            // ürün tipi
    "Quantity": 2,            // adet
    "PrComment":"acısız",     // ürün notu
    "TmpIndex": 0,            // yerel sıralama indeksi
    "Price_t":  300.00        // toplam (Price_s * Quantity)
  }
]
```

- Gövde = `ObservableCollection<SrProducts>` nesnesinin `JsonConvert.SerializeObject` ile serileştirilmiş hali (JSON dizisi).
- Başarılıysa uygulama ana masa ekranına döner (`PopToRootAsync`) ve yerel bir "Hi" bildirimi gönderir.
- Başarısızsa: *"Sipariş kayıt işlemi başarısız!"* uyarısı.

### Parametre kaynakları
| Param | Kaynak | Açıklama |
|---|---|---|
| `fid` | `CurrentField` | Seçilen bölüm (Fields) id'si |
| `tid` | `TmpTableId` | Seçilen masa (TableId) |
| `sid` | `TmpSid` | Adisyon/satış id'si (yeni masa = 0, açık masa = mevcut sid) |
| `uid` | `TmpUid` | Login'den dönen kullanıcı id |
| `uname` | `TmpUsername` | Login'den dönen kullanıcı adı |

---

## 8. Veri Modelleri (DTO Şemaları)

JSON alan adları = C# property adları **birebir** (JsonProperty attribute'u yok, PascalCase/karışık aynen gider). Okumada Newtonsoft büyük/küçük harfe duyarsızdır.

```csharp
// Login yanıtı
SrLoginEntries  { int id; string name; int auth; }

// Şube
SrBranch        { int id; int secid; string shortcode; string ip; }

// Bölüm (salon alanı)
SrFields        { int id; string name; }

// Ürün kategorisi
SrMenuCat       { int id; string name; }

// Ürün (hem listeleme hem SaveSales gövdesi)
SrProducts      { int PrId; string PrName; decimal Price_s; int P_Type;
                  int Quantity; string PrComment; int TmpIndex; decimal Price_t; }

// Açık masa / masa durumu
SrOpenTables    { int Sid; string TableName; int Days; int Hours; int Minutes;
                  decimal TotalPrice; decimal Discount; string Usr; string OpenDate;
                  int TableId; /* Duration (hesaplanan) */ }

// Adisyon detay satırı
SrSalesDetails  { int Dsid; int Sid; string TableName; string ProductName;
                  decimal UnitPrice; decimal TotalPrice; int Quantity;
                  string SalesDate; /* QtyUnit */ }

// Bekleyen/Hazırlanıyor/Hazır (mutfak)
SrBekleyen      { int sid; string cname; string urunler; string salesdate; }

// Ödeme
SrPayments      { int PayId; int Sid; string TableName; int Days; int Hours; int Minutes;
                  string PayDate; decimal TotalPrice; string PayType; string PayMethod;
                  string Usr; int TableId; /* Duration */ }

// Satış raporu satırı
SrSalesReport   { int Prid; string Prname; int Quantity; int Mid; }

// Zarf
SasResult<T>    { bool Result; T Data; string Message; }
```

---

## 9. Örnek İstekler (curl ile test)

> Backend'i incelemek/geliştirmek için önce bu isteklerle canlı yanıtları görün.
> Gerçek alan değerlerini (Result/Data/Message) teyit ederek Node.js tarafını buna göre yazın.

```bash
HOST=88.247.51.116:8081
BASE="http://$HOST/SASncps/@Action"
H=(-H "SasUsername: root" -H "SasPasswd: 1234")

# 1) Giriş
curl "${H[@]}" "$BASE/Auth!?cc=MUSTERI_KODU&un=KULLANICI&pw=SIFRE"

# 2) Şubeler
curl "${H[@]}" "$BASE/Branch!?Auth=22"

# 3) Bölümler
curl "${H[@]}" "$BASE/Fields!"

# 4) Masa durumları (bölüm 1)
curl "${H[@]}" "$BASE/TableStatus!?field=1"

# 5) Kategoriler + ürünler
curl "${H[@]}" "$BASE/MenuCat!"
curl "${H[@]}" "$BASE/Product!?cat=1"

# 6) Sipariş kaydet (POST)
curl "${H[@]}" -H "Content-Type: application/json" \
  -X POST "$BASE/SaveSales!?fid=1&tid=5&sid=0&uid=1&uname=KULLANICI" \
  -d '[{"PrId":123,"PrName":"Adana Dürüm","Price_s":150.0,"P_Type":0,"Quantity":2,"PrComment":"","TmpIndex":0,"Price_t":300.0}]'

# 7) Açık adisyon detayı / yazdır
curl "${H[@]}" "$BASE/SalesDetails!?sid=42"
curl "${H[@]}" "$BASE/SalesPrint!?sid=42"

# 8) Mutfak ekranı
curl "${H[@]}" "$BASE/Bekleyen!"
curl "${H[@]}" "$BASE/Hazirlaniyor!"
curl "${H[@]}" "$BASE/Hazir!"

# 9) Raporlar
curl "${H[@]}" "$BASE/Payments!?start=2026-11-01%2006:00:00&end=2026-11-15%2006:00:00"
curl "${H[@]}" "$BASE/SalesReport!?start=2026-11-01%2006:00:00&end=2026-11-15%2006:00:00"
```

---

## 10. Node.js Web Uygulaması İçin Notlar

**Mimari önerisi:** Tarayıcı doğrudan `88.247.51.116:8081`'e istek atamaz
(CORS + karışık içerik/HTTP sorunu + gömülü header'lar tarayıcıda açığa çıkar).
Bu yüzden:

```
[ Web tarayıcı (SPA) ] → HTTPS → [ Node.js backend (proxy/BFF) ] → HTTP → [ 88.247.51.116:8081 ]
```

1. **Node.js (Express) bir BFF/proxy** yazın. `SasUsername/SasPasswd` header'larını
   **sadece sunucu tarafında** ekleyin, tarayıcıya sızdırmayın.
2. Yukarıdaki 15 endpoint için birer Node route'u açın (örn. `/api/products?cat=1`
   → arkada `Product!?cat=1`). URL'deki `@Action/` ve `!` ayraçlarını aynen koruyun.
3. Yanıttaki `{Result, Data, Message}` zarfını açıp frontend'e sade veri verin.
4. Tarih parametrelerini `yyyy-MM-dd 06:00:00` formatında üretin.
5. Sipariş kaydını (`SaveSales`) POST + JSON dizi gövdesiyle aynen taklit edin.
6. Frontend: login → şube → bölüm → masa → kategori → ürün → sepet → kaydet akışı.

**Dikkat / doğrulanacaklar (canlı sunucuda test ederek):**
- `Result` alanının tipi (bool mu, 1/0 mı) ve başarı değeri.
- `Data`'nın liste endpoint'lerinde düz dizi mi yoksa iç içe mi geldiği.
- `Auth=22` sabitinin sizin sunucunuzda da geçerli olup olmadığı.
- `SaveSales` yanıtının içeriği (yeni `sid` dönüyor mu?).
- Fiyat alanlarının ondalık ayracı (`.` / `,`).

> ⚠️ Gömülü `root`/`1234` kimlik bilgileri güvensizdir. Yeni sistemde gerçek
> kimlik doğrulama (token/oturum) ekleyin ve bu header'ları gizli tutun.

---

*Bu döküman APK'nın statik analiziyle (dnfile/dncil ile IL decompile) çıkarılmıştır;
canlı sunucu yanıtlarıyla teyit edilmesi önerilir.*
