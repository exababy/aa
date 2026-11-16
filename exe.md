# NetCHIEF Smart (POS) — Node.js ile Sıfırdan Yeniden İnşa Şartnamesi

Bu belge, masaüstü restoran POS programı **NetCHIEF Smart** (`NetCHIEF_Smart.exe`, .NET/DevExpress)
yerine **aynı işlevlere sahip yeni bir uygulamayı Node.js ile sıfırdan** yazacak geliştirici/ajan
içindir. Kaynak: orijinal exe'nin statik çözümlemesi + `config.ini` + gün sonu rapor örneği.

Program **doğrudan MySQL** veritabanına (`netchief`) bağlanır; ayrıca mobil uygulama için kendi
içinde bir **HTTP API (SASncps)** yayınlar ve yazıcı/çekmece/terazi/arayan-no gibi donanımları kullanır.

> Not: Orijinal uygulama şifreleri **düz metin** saklar ve MySQL'e `root` ile bağlanır. Yeni
> uygulamada şifreleri hash'lemeniz ve kısıtlı bir DB kullanıcısı kullanmanız önerilir (uyumluluk
> için okuma şeması aynı kalmalı).

---

## 1. Mimari

```
            ┌───────────────────────────── NetCHIEF Smart (Node) ─────────────────────────────┐
            │  • POS arayüzü (masa/adisyon/ödeme/rapor...)                                     │
 Yazıcılar ─┤  • MySQL istemcisi  ───────────────► MySQL  netchief  (192.168.1.x:3306)         │
 Çekmece   ─┤  • HTTP API (SASncps)  ◄──── 8081 ──── Mobil PWA / el terminali                   │
 Terazi    ─┤  • Çağrı (Caller-ID, COM)                                                         │
 Barkod    ─┤  • Çoklu terminal senkronu (lmv_ccard "Refresh" bayrağı)                          │
            └─────────────────────────────────────────────────────────────────────────────────┘
```

- **Tek veritabanı, çok terminal:** Birden fazla kasa aynı MySQL'e bağlanır. Değişiklik bildirimi
  için `lmv_ccard` tablosunda `cname='Refresh'` satırının `tag`'i 0/1 yapılır (diğer terminaller
  bunu yoklayıp ekranı tazeler). Yeni mimaride WebSocket/poll ile aynı etki sağlanabilir.
- **Bölüm bazlı yazıcı yönlendirme:** her ürünün `prn` alanı hangi yazıcıya (mutfak/bar/fırın...)
  düşeceğini belirler.

### Önerilen Node yığını
- MySQL: `mysql2/promise`
- HTTP API (connector): Node `http` veya Express (8081, `/SASncps/@Action/...`)
- Yazıcı: ESC/POS (`node-thermal-printer` / ham yazıcı) veya Windows yazıcı adına ham gönderim
- Seri port (terazi, caller-id): `serialport`
- Çekmece: yazıcıdan kick komutu veya `drawer.exe` muadili
- Arayüz: masaüstü için Electron ya da yerel web arayüzü (tam ekran kiosk)

---

## 2. Yapılandırma (`config.ini` eşdeğeri)

Orijinal `config.ini` anahtarları (hepsi korunmalı):

**[connection]**
| Anahtar | Açıklama |
|---|---|
| `server_ip` | MySQL sunucu IP (ör. 192.168.1.251) |
| `port` | MySQL portu (3306) |
| `db` | Veritabanı adı (`netchief`) |
| `user` | MySQL kullanıcı |
| (şifre) | Bağlantı dizesinde; yeni sürümde güvenli saklayın |
| `scales_port` | Terazi seri portu (COM1) |
| `scales` | Terazi aktif mi (0/1) |
| `readerRun`, `reader_port`, `reader_lock`, `lock_timeout` | Kart/okuyucu ayarları |

**[main]**
| Anahtar | Açıklama |
|---|---|
| `restaurant_name` | İşletme adı (fiş/rapor başlığı) |
| `pack_id` | Paket ön eki (ör. `KY`) |
| `pack_prn` | Paket yazıcısı (ör. `KEBAP`) |
| `pack_prn_multi`, `pack_prnalt` | Paket yazdırma seçenekleri |
| `mvment` | Stok/hareket |
| `StartTime` | İş günü başlangıcı (`06:00`) |
| `WorkingHour` | Çalışma saati (24) |
| `TKey` | — |
| `MultiMenu` | Çoklu menü/fiyat grubu |
| `Kiosk` | Kiosk modu |
| `PromtUsr`, `PromtPax` | Satışta kullanıcı/pax sor |
| `SalesDis` | — |
| `ConnectorListen` | **Mobil API dinleyici aç/kapa (1/0)** |
| `ScalePrn` | Terazi fişi |
| `PrintSales` | Satışta fiş bas |
| `ShowTPrice` | — |
| `CheckPrn` | Hesap/adisyon yazıcısı (ör. `BAR`) |
| `SaveNotPrint` | Kaydet ama basma |
| `EodReceiptPrn` | Gün sonu yazıcısı (`BAR`) |
| `Cid` | Caller-ID aktif |
| `Drawer` | Çekmece |
| `PrintLogo` | Fişe logo |
| `PayPromt` | Ödemede sor |
| `ETM` | — |
| `JokerPrn` | Joker ürün yazıcısı (`KEBAP`) |

---

## 3. Veritabanı şeması — `netchief` (MySQL)

Tablolar ve rolleri (kolonlar exe'deki SQL'lerden çıkarıldı; `…` = kullanılan başlıca alanlar):

### Satış / adisyon
- **`lmv_sales`** — açık/kapalı adisyonlar. Alanlar:
  `sid, fieldid, tableid, userid, username, inuse, open_date, salesdate, pax, prepay, discounted,
  discounttag, comments, paket, paket_id, totalprice, isprinted, islocked, ispayed, alerton,
  alerttime, tag11, section`.
  `inuse=1` → masa açık. `discounted` → indirim tutarı. `prepay` → ön ödeme. `isprinted/islocked`
  → yazdırma/kilit durumu. `alerton/alerttime` → masa süre uyarısı.
- **`lmv_salesdetails`** — adisyon satırları. Alanlar:
  `detailedsalesid, salesid, fieldid, tableid, prid, prname, quantity, unitprice, salesprice,
  totalprice, catid, p_type, prn, isprinted, notprepare, comment, ispay, isgift, hm_c, pricegroup,
  uretim, mfd, section, prmalz, prmalzex, propt, prstatus, mid, userid, username, salesdate`.
  `p_type=2` → yarım porsiyon satılabilir. `prn` → yazıcı. `notprepare` → mutfağa düşmesin.
  `isgift` → ikram. `ispay` → kısmi ödenen adet. `comment` → ürün notu.
- **`lmv_salesdetails_del`** — **iptal edilen** satırlar. Silinen satır buraya kopyalanır,
  `COMMENT` iptal sebebi olur (`Yanlış Satış`, `Satış Düzenleme`, `Adisyon…`, `Tahsilat…`).
- **`lmv_sqsales` / `lmv_sqsalesdetails`** — "hızlı satış / senkron" (SenqronSales ile). Aynı yapı.

### Menü
- **`lmv_menu_cat_top`** — kategoriler: `id, name, tag, psort`. (`id=999` özel, listelerde hariç.)
- **`lmv_product`** — ürünler:
  `prid, prname, catid, price, price_s, price_fd, price_yr, p_type, prn, inuse, pdasort, hm,
  packpr1, packpr2, packqty, mid, unit, unit_prs`.
  `price_s` satış, `price_fd`/`price_yr` alternatif fiyat grupları. `inuse=1` aktif. `prn` yazıcı.
  `pdasort` mobil sıralama. `packqty>0` → tartılan/paket ürün (barkod). `mid` rapor grubu.

### Ödeme / cari
- **`lmv_payments`** — ödeme/tahsilat:
  `payid, fieldid, tableid, salesid, totalprice, userid, username, paymethod, paymethoddetails,
  pay_comment, pay_type, paydate, paytag`.
  **paymethod:** `1=Nakit, 2=Kredi Kartı, 3=Cari (veresiye), 9=diğer (pay_type ile gruplanır)`.
  `paymethoddetails` → cari ödemede müşteri `cid`. `salesid=0` → adisyonsuz tahsilat.
- **`lmv_customer`** — cari/müşteri: `cid, cname, caddress, cphone, ccomment, inuse, bakiye, static`.
  `bakiye` cari borç/alacak (tahsilat ve cari satışta güncellenir).

### Bölüm / şube / kullanıcı / personel
- **`lmv_fields`** — bölümler: `id, name, tag, pda`. **`pda=1` → mobil (el terminali) görür.**
  (Paket Servis genelde `pda≠1` → mobilde çıkmaz.)
- **`lmv_section`** — şubeler: `id, secid, shortcode, ip, inuse`.
- **`lmv_users`** — kullanıcılar: `id, name, password (düz metin), auth (yetki), section, smartlogin, crid`.
  `smartlogin=1` → mobilden girebilir. `auth` küçük sayı = üst yetki (ör. <14 kasiyer/yönetici).
- **`lmv_staff`** — personel: `namesurname, gorevi, ucret, tag`.

### Diğer
- **`lmv_rezerv`** — rezervasyon: `rid, rname, rphone, rdate, rtime, rcomment`.
- **`lmv_calls`** — gelen çağrı: `cid, callerid, call_chan, call_time, call_date, customer_id, customer`.
- **`lmv_notice`** — terminaller arası bildirim: `uid, uname, sid, fieldid, tableid` (ör. yeni sipariş "Hi").
- **`lmv_ccard`** — tazeleme sinyali: `cname='Refresh'` satırının `tag`'i 0/1 toggle.
- **`lmv_count`** — sayaç (fiş/sıra no): `count`.
- **`lmv_mails`** — e-posta/bildirim hedefleri: `name, g`.
- **`lmv_payoutunit`** — ödeme/çıkış birimleri.
- **`lmv_userid`, `lmv_username`, `lmv_userid_chg`, `lmv_username_chg`** — kullanıcı oturum/değişim izleri.

---

## 4. Oturum & yetki

- Giriş: `SELECT usr.id, usr.name, usr.auth FROM lmv_users usr INNER JOIN lmv_section sc
  ON usr.section=sc.id WHERE usr.name=? AND usr.password=? [AND usr.smartlogin=1 AND sc.secid=?]`
  (mobil girişte `smartlogin=1` ve `secid` şartı; masaüstünde yerel kullanıcı).
- **Yetki (auth):** küçük sayı üst yetki. Rapor/kasa/yönetim ekranları düşük `auth` (ör. ≤13)
  kullanıcıya açılır; garson (ör. 14) yalnız satış yapar. (Mobil tarafta eşik `SAS_REPORT_MAX_AUTH`.)

---

## 5. Ekranlar ve akışlar (POS)

### 5.1 Masa/bölüm ekranı
- Sol menüde bölümler: **Salon, Paket Servis, Bekleyen, Çağrı Merkezi, Kasa Çıkış** (ve tanımlı diğerleri).
- Salon: numaralı **masa ızgarası** (ör. 1–72). Açık masalar (lmv_sales.inuse=1) renkli + tutar;
  boş masalar numarayla. Masaya dokun → adisyon ekranı.
- `TableStatus` okuması: açık adisyonlar ve süreleri (`TIMESTAMPDIFF` ile gün/saat/dk).
- Üstte saat, işletme adı, **Çekmece Aç**, **Seçenekler**.

### 5.2 Adisyon (sipariş) ekranı
- Sol: **kategori** butonları (lmv_menu_cat_top) ve seçili kategorinin **ürünleri** (lmv_product,
  `inuse=1 AND packqty=0 ORDER BY pdasort DESC`). **Ara** (ürün arama) kutusu.
- Sağ: **adisyon detayları** (eklenen ürünler, adet, b.fiyat, toplam). Kullanıcı/açıklama alanı.
- Ürüne dokun → satıra ekle (adet 1; `p_type=2` ise 0,5 adım). Adet +/-; satır sil (iptal akışı).
- **Yeni adisyon:** `INSERT INTO lmv_sales(fieldid,tableid,userid,username,inuse,open_date,pax,tag11,…)`.
- **Ürün ekleme:** `INSERT INTO lmv_salesdetails(…, prn, p_type, notprepare, …)` — `prn`,`p_type`,`hm_c`
  ürünün kaydından alınır; `catid` ürünün kategorisi.
- **Kaydet:** toplamı güncelle: `UPDATE lmv_sales SET totalprice=…, salesdate=…`; ürünleri
  `isprinted=1` yap; `lmv_ccard` refresh toggle; gerekiyorsa mutfak/bar fişi bas (bkz. §7).
- **Düzenle/Not:** satıra `comment`; `notprepare` ile mutfağa düşmeyen kalem.

### 5.3 Ürün iptali / silme
- Satır silinince: `INSERT INTO lmv_salesdetails_del SELECT * FROM lmv_salesdetails WHERE detailedsalesid=?`
  sonra `delete from lmv_salesdetails where detailedsalesid=?`.
- İptal sebebi: `UPDATE lmv_salesdetails_del SET COMMENT=?` (Yanlış Satış / Satış Düzenleme / …).
- Kısmi iptal: `UPDATE lmv_salesdetails_del SET quantity=?` ve kalan adet güncellenir.
- Gün sonu "İptal İşlemleri" bölümü bu tablodan gelir.

### 5.4 İndirim
- Tutar/yüzde indirim: `UPDATE lmv_sales SET discounted=?` (ör. `%10` → `salestotal*0.1`),
  `discounttag` ile etiket. İptal: `discounted=0, discounttag=''`.

### 5.5 İkram
- Satır ikram: `isgift` işaretlenir; tutar 0 yazılır. Gün sonu "İkram Detayları" bu kalemlerden.

### 5.6 Pax (kişi sayısı)
- `UPDATE lmv_sales SET pax=?` (+/- butonları). Gün sonu PAX toplamı.

### 5.7 Hesap taşı / böl / birleştir
- **Taşı (masa değiştir):** `UPDATE lmv_salesdetails SET fieldid=?, tableid=?` (ve `lmv_sales`).
- **Birleştir/Aktar:** kaynak adisyon `UPDATE lmv_sales SET inuse=0, comments='hesap aktar/birleştir…'`,
  satırlar hedef adisyona taşınır.
- **Böl (parçalı):** seçilen ürünler için ayrı ödeme (bkz. Multi/parçalı ödeme).

### 5.8 Ödeme / tahsilat
- **Ödeme ekranı:** adisyon tutarı, ödeme türü seçimi.
  - Nakit: `INSERT INTO lmv_payments(…, paymethod=1, pay_comment='Nakit', …)`.
  - Kredi Kartı: `paymethod=2, pay_comment='Kredi Kartı'`.
  - Cari (veresiye): `paymethod=3, paymethoddetails=<cid>`; `lmv_customer.bakiye` güncellenir.
  - Diğer (`paymethod=9`, `pay_type` ile: yemek çeki vb.).
- Ödeme sonrası adisyon kapanır: `UPDATE lmv_sales SET inuse=0, isprinted=…, totalprice=…` /
  `alerton=0, totalprice=0, discounted=0` (kapandı).
- **Multi / parçalı ödeme:** bir adisyon birden çok ödeme satırıyla; `ispay` ile ödenen adetler izlenir.
- **Cari tahsilat:** adisyonsuz tahsilat (`salesid=0`); `lmv_customer.bakiye` artar/azalır:
  `UPDATE lmv_customer SET bakiye=bakiye±…`.
- **Ödeme No. ile iptal:** `DELETE from lmv_payments where payid=?` (yetkiyle), bakiye geri alınır.

### 5.9 Cari hesaplar
- Müşteri ekle/düzenle: `insert/update lmv_customer(cname,caddress,cphone,ccomment,…)`;
  pasifle: `update lmv_customer set inuse=0 where cid=?`. Hesap ekstresi (bakiye, tahsilatlar).

### 5.10 Rezervasyon
- `INSERT INTO lmv_rezerv(rname,rphone,rdate,rtime,rcomment)`; düzenle/sil; güne göre listele
  (`select * from lmv_rezerv where rdate=?`). `rezerv.html` çıktısı.

### 5.11 Çağrı merkezi (Caller-ID)
- COM cihazından gelen numara: `insert into lmv_calls(callerid,call_chan,call_time,customer_id,customer)`.
  Numaraya göre `lmv_customer`'dan müşteri eşleştir; günün çağrıları listelenir. (COM: `cidv5callerid`.)

### 5.12 Kasa
- **Kasa Hareketleri / Kasa Çıkış:** nakit giriş/çıkış kayıtları (ödeme/çıkış birimleri).
- **Çekmece Aç:** yazıcıdan kick / `drawer.exe` muadili.

### 5.13 Yönetim (düşük auth)
- **Bölümler:** `insert/update/delete lmv_fields` (ad, sıra, pda).
- **Kategoriler:** `insert/update lmv_menu_cat_top`; pasifle `tag=0`.
- **Ürünler:** `insert/update lmv_product(prname,catid,price,price_s,price_fd,price_yr,prn,p_type)`;
  pasifle `inuse=0`; fiyat/isim güncelle.
- **Kullanıcılar:** `insert/update/delete lmv_users` (ad, şifre, auth).
- **Personel:** `insert/update lmv_staff`.

---

## 6. İş kuralları

1. **İş günü 06:00'da başlar** (`StartTime`). Rapor/gün aralıkları `DATE_FORMAT(... '%Y-%m-%d 06:00:00')`
   mantığıyla; `WorkingHour=24`.
2. **Ödeme türleri:** `1 Nakit, 2 Kredi Kartı, 3 Cari, 9 diğer`. Cari ödeme/tahsilat `lmv_customer.bakiye`'yi günceller.
3. **Yarım porsiyon:** `lmv_product.p_type=2` → adet 0,5 adımlı. (Mobilde kategori bazında aç/kapat.)
4. **Aktif ürün:** satış ekranları `inuse=1` filtreler; mobil `Product` ucu filtrelemez (mobil tarafta elle gizleme gerekir).
5. **Yazıcı yönlendirme:** satırın `prn` değeri (ürün kaydından) hangi yazıcıya basılacağını belirler.
6. **Paket servis:** `lmv_fields.name='Paket Servis'`; adisyonda `paket`,`paket_id` alanları; paket fişi `pack_prn`.
7. **notprepare:** mutfağa gönderilmeyen kalemler (ör. hazır içecek) fiş yönlendirmesinde atlanır.
8. **Çoklu terminal tazeleme:** her kayıt sonrası `lmv_ccard` "Refresh" `tag` toggle → diğer ekranlar yeniler.
9. **Kilit:** `lmv_sales.islocked` ile aynı adisyonda çakışma engellenir (`lock_timeout`).
10. **Para/adet:** TL, iki ondalık; tartılan ürünlerde (`packqty`) adet kesirli (ör. 0,490 kg).

---

## 7. Yazdırma

- **Yazıcı adları** ürün `prn` alanından: ör. `KEBAP`, `BAR`, `MUTFAK`/`MUTFAK1`, `FIRIN`, `ARASICAK`.
  Fiş basarken ürünler `prn`'e göre gruplanıp ilgili yazıcıya gönderilir
  (`SELECT PRN FROM lmv_product where prn='MUTFAK' OR prn='MUTFAK1' GROUP BY PRN`).
- **Fiş türleri:**
  - **Mutfak/hazırlık fişi:** yeni eklenen, `notprepare=0` kalemler ilgili üretim yazıcısına.
  - **Adisyon/hesap fişi** (`CheckPrn`, ör. BAR): müşteriye hesap.
  - **Paket fişi** (`pack_prn`, `pack_prn_multi`, `pack_prnalt`).
  - **Gün sonu** (`EodReceiptPrn`).
- Yazdırma sonrası `UPDATE lmv_salesdetails SET isprinted=1`, `UPDATE lmv_sales SET isprinted=…`.
- `PrintLogo`, `ShowTPrice`, `SaveNotPrint` gibi bayraklar davranışı değiştirir.
- Yeni uygulamada ESC/POS (ağ/USB/seri yazıcı) ile aynı yönlendirme kurulmalı.

---

## 8. Donanım

- **Çekmece:** `Drawer`/`drawer.exe` — yazıcı kick komutu.
- **Terazi:** `scales`, `scales_port` (COM1) — tartılan ürün (barkod/`packqty`) için ağırlık okunur.
- **Barkod:** `ARGUSBCID` arabirimi; barkodlu/tartılı ürünler.
- **Caller-ID:** `cidv5callerid` (COM) — gelen numara `lmv_calls`'a.
- Node'da: `serialport` (terazi/caller-id), yazıcı kütüphanesi, barkod okuyucu (HID/klavye emülasyonu).

---

## 9. Mobil API (SASncps connector)

Program, `ConnectorListen=1` iken kendi içinde HTTP dinleyici açar:
`http://+:8081/SASncps/@Action/<ACTION>!?params`. Header: `SasUsername`, `SasPasswd`.
Yanıt zarfı: `{ "Result":"true"/"false", "Data":[...], "Message":"..." }`. Tanınmayan action → `Diger Talepler`.

| Action | Parametre | SQL / işlev |
|---|---|---|
| `Auth` | cc, un, pw | `lmv_users`×`lmv_section`, `smartlogin=1 AND secid=cc` → `{id,name,auth}` |
| `Branch` | auth=22 | `SELECT id,secid,shortcode,ip FROM lmv_section WHERE inuse=1` |
| `Fields` | — | `SELECT id,name FROM lmv_fields WHERE tag=1 AND pda=1` |
| `MenuCat` | — | `SELECT id,name FROM lmv_menu_cat_top WHERE tag=1 AND id<>999 ORDER BY psort` |
| `Product` | cat | `SELECT prid,prname,price_s,p_type FROM lmv_product WHERE catid=? AND prname<>'' ORDER BY pdasort DESC` |
| `TableStatus` | field (ops.) | Açık masalar: `lmv_sales`×`lmv_fields`, süre `TIMESTAMPDIFF`, `ORDER BY open_date DESC` |
| `SalesDetails` | sid | `lmv_salesdetails`×`lmv_fields`, group by prname |
| `Payments` | start, end | `lmv_payments`×`lmv_fields`, tarih aralığı |
| `SalesReport` | start, end | `lmv_salesdetails`×`lmv_product`, group by ürün |
| `SaveSales` | fid,tid,sid,uid,uname,comm + gövde | Yoksa `lmv_sales` insert, her ürün `lmv_salesdetails` insert, toplam güncelle, Paket Servis özel dalı |
| `SalesPrint` | sid | Adisyon fişi |
| `PackPrint` | sid | Paket fişi |
| `CheckState` | — | `{"Result":"true"}` (ping) |
| `CallerID` | ci | Arayan numara sorgu |
| `SenqronGorev` / `SenqronSales` | sq / fid,tid,sqsipid | `lmv_sqsales`/`lmv_sqsalesdetails` senkron |

`SaveSales` gövdesi (ürün dizisi): `{ PrId, PrName, Price_s, P_Type, Quantity, PrComment, TmpIndex, Price_t }`.
Tarih parametreleri `yyyy-MM-dd HH:mm:ss`. `Result` string gelebilir; `Data` string'e sarılı olabilir.

(Ayrı mobil PWA'yı bu API'ye göre yazmak için ek davranış kuralları: masayı 1..N üret, Salon'u
Bahçe/Salon'a böl, fiyatı sunucuda doğrula, raporları yalnız kasiyere göster — bunlar PWA'ya özgü,
POS'un kendisi için zorunlu değil.)

---

## 10. Raporlar (Gün Sonu / Z / Satış / Kasa / Ekstre)

Orijinal raporlar **HTML tablo** olarak üretilip yazıcıya/ekrana basılır. **Gün Sonu Raporu** bölümleri
(gerçek örnekten):
1. **Kasiyer Sayım** (Nakit/Kredi, sayım farkı)
2. **Tahsilat İşlemleri** (Nakit/Kredi adet ve tutar) + TOPLAM
3. **Satış Grup Özet** (Bölüm bazında: Salon, Paket Servis — işlem adedi, tutar)
4. **Cari Satışlar / Cari Tahsilatlar**
5. **Satış Özet** (kategori grubu: Ara Sıcak, Porsiyon, Dürümler, İçecekler… miktar/tutar)
6. **Satış Detay** (ürün bazında miktar/fiyat/tutar)
7. **İkram Detayları** (isgift kalemler)
8. **İptal İşlemleri** (`lmv_salesdetails_del`, sebep)
9. **Ödeme Özeti / Ödeme Listesi** (ödeme türüne göre)

İlgili özet sorguları (örnek):
- Ödeme toplamı: `SELECT paymethod, SUM(totalprice), COUNT(*) FROM lmv_payments WHERE paydate>=? GROUP BY paymethod`
- Kategori özet: `SELECT mct.name, SUM(quantity), SUM(totalprice) FROM lmv_salesdetails sd INNER JOIN lmv_menu_cat_top mct ON sd.catid=mct.id WHERE salesdate>=? …`
- İptal: `SELECT prname, SUM(quantity), comment, p_type, SUM(totalprice) FROM lmv_salesdetails_del WHERE salesdate>=? …`
- Bölüm özet: `SELECT fl.name, COUNT(*), SUM(py.totalprice) FROM lmv_payments py INNER JOIN lmv_fields fl ON py.fieldid=fl.id WHERE py.paydate>=? …`

Diğer raporlar: **Satış Raporları** (tarih aralığı, ürün bazında), **Kasa Hareketleri**,
**Hesap Ekstresi** (cari), **Z Raporu / Yazarkasa Fişi** (ETM entegrasyonu varsa).

---

## 11. `.exe` olarak paketleme

- Node uygulaması `pkg`/`nexe` ile tek `.exe` ya da Electron kurulumu olarak paketlenir.
- Windows'ta: yazıcı/COM/çekmece erişimi; MySQL'e LAN üzerinden bağlantı; 8081 connector portu.
- Ayarlar `config.ini`/`.env` benzeri bir dosyadan okunmalı (orijinal `config.ini` anahtarları).
- Çoklu terminal: aynı MySQL, `lmv_ccard` refresh sinyali (veya WebSocket).

---

## 12. Kabul ölçütleri (özet)

1. Giriş (auth'a göre yetki) → bölüm → masa → adisyon aç → ürün ekle (0,5'li dâhil) → kaydet (mutfak fişi).
2. Ödeme: Nakit/Kredi/Cari/Multi, adisyon kapanır, cari bakiye güncellenir.
3. İptal (sebepli, `_del` tablosu), indirim, ikram, pax, taşı/birleştir çalışır.
4. Cari hesaplar, rezervasyon, çağrı-no, kasa hareketleri, çekmece.
5. Yazıcı yönlendirme (`prn`): mutfak/bar/fırın/paket ayrı; gün sonu/adisyon/paket fişleri.
6. Gün Sonu ve satış/kasa/ekstre raporları (yukarıdaki bölümlerle) doğru tutarlar.
7. Mobil API (SASncps) 8081'de yayınlanır; §9'daki 16 action aynı davranışla çalışır.
8. Çoklu terminalde değişiklikler yayılır; aynı adisyonda kilit çakışması önlenir.
