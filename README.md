# Kampüs Yoklama — QR MVP

Yerel demonstrasyon: bölüm/dönem/ders/öğrenci tanımlarını, haftalık oturumları, dinamik QR’ı, öğrenci kontrolünü ve denetim günlüğünü gösterir.

## Çalıştırma

```bash
npm install
npm run server   # terminal 1: yerel OİS adaptörü ve yoklama API'si
npm run dev      # terminal 2: arayüz (ağda test için http://MAC_IP:5173)
```

Tarayıcıda QR oturumunu açın. Telefonla QR okutulduğunda `/student.html` doğrulama ekranı açılır. Yerel test öğrencileri: `253004001 / Ayşe Demir`, `253004005 / Mehmet Kaya`, `253004006 / Zeynep Çelik`, `253004009 / Can Yılmaz`. Aynı Wi-Fi’da telefonla denemek için bilgisayarınızın yerel IP adresi üzerinden arayüzü açın.

Yerel öğretim elemanı girişi: TC kimlik no `12345678901`, varsayılan şifre `8901` (TC'nin son dört hanesi). Bu test hesabı, hoca kodu `2500002318` için PSK 301 Fizyolojik Psikoloji (`ders_id: 27063`, şube `1`) kaydını açar. 15.06.2026’dan başlayarak 14 haftalık teorik (3 saat) plan ve iki test öğrencisi hazırdır. Aynı ders ve gün için en fazla üç QR oturumu açılabilir; dördüncü istek sunucuda engellenir.

Yerel yönetici girişi: `/admin.html` adresinde kullanıcı adı `yonetici`, şifre `Admin123!`. Yeni yönetici özelliklerini çalıştırmak için açık olan `npm run server` sürecini durdurup yeniden başlatın.

## Render ile çevrimiçi test

Bu proje tek bir Render **Web Service** olarak çalışacak şekilde hazırlanmıştır: Express hem `/api` uçlarını hem de `npm run build` ile oluşan arayüzü aynı HTTPS adresinden sunar. Böylece öğretmen bilgisayarı ve sınıf TV’si aynı URL’yi açar; yerel ağ/IP paylaşımı gerekmez.

1. Depoyu Render’a bağlayın ve `render.yaml` dosyasını kullanın. Bu dosya ücretsiz `kampus-yoklama-staging-db` Postgres veritabanını da tanımlar.
2. Render, web servisine aynı bölgedeki veritabanının özel `DATABASE_URL` bağlantısını otomatik verir. Hesap şifre özetleri, dönem takvimi, yoklama geçmişi ve denetim günlüğü bu veritabanına yazılır; servis yeniden başlasa bile korunur.
3. OİS kullanıcı bilgilerini yalnız Render’ın gizli ortam değişkenlerine girin; `.env` dosyasını veya bu bilgileri depoya koymayın.
4. İlk çevrimiçi denemede yazımı kapalı tutun. OİS testine gerçek gönderim yapılacaksa yalnız yetkili test ayarlarıyla `OBS_LIVE_WRITE=true` açılmalıdır. Canlı OİS ayarları ancak tüm testler tamamlandıktan sonra değiştirilmelidir.

Ücretsiz Render Web Service’leri 15 dakika hareketsizlikte uykuya geçer; bu nedenle sınıfta kesintisiz test için dersten önce siteyi açıp hazır bekletin. Ücretsiz Render Postgres test için uygundur ancak 30 gün sonra sona erer; gerçek kullanımda kalıcı, ücretli bir veritabanına geçilmelidir.

## OİS test gönderimi

Varsayılan davranış **test modudur**: ders bitince OİS isteği hazırlanır fakat dış sisteme yazılmaz. Gerçek test gönderiminden önce `.env.example` dosyasını `.env` adıyla kopyalayın; yetkili OİS erişim bilgilerini yalnızca bu sunucu dosyasına yazın ve `OBS_LIVE_WRITE=true` yapın. `.env` hiçbir zaman Git’e veya arayüz koduna eklenmemelidir.

`server.js`, gerçek OİS verisi gelmeden önce hoca derslerini, ders öğrencilerini ve yoklama yazımını taklit eden güvenli bir adaptördür. Gerçek API erişimi geldiğinde yalnızca bu adaptörün veri çekme ve OİS’e gönderme fonksiyonları değiştirilecektir; QR ve yoklama kuralları aynı kalır.

## Güvenlik tasarımı (üretim)

1. Öğretim elemanı SSO + MFA ile oturumu açar. Sunucu yalnızca açık ders saati/oda için oturum oluşturur.
2. Her 20 saniyede kriptografik olarak rastgele, tek kullanımlık QR challenge üretir. Veritabanında ham değer değil SHA-256 özeti tutulur; challenge en fazla 25 saniye geçerlidir.
3. Öğrenci QR’ı açtığında kurum SSO oturumu ve cihazdaki WebAuthn/passkey onayı gerekir. Öğrenci numarası asla kimlik doğrulama yerine geçmez.
4. Sunucu aynı transaction içinde challenge süresini, oturum durumunu, ders kaydını, cihaz imzasını ve `UNIQUE(session_id, student_id)` kuralını doğrular; sonra challenge’ı tüketir ve yoklamayı yazar.
5. Ağ/konum sinyalleri tek başına karar vermez; risk skoru üretir. Kampüs Wi-Fi, Bluetooth sınıf beacon’ı veya öğretmen onayı yoksa kayıt `REVIEW` akışına alınır. VPN/IP konumu güvenlik kanıtı sayılmaz.
6. Başarılı ve reddedilen denemeler zincirlenmiş, append-only denetim günlüğüne yazılır. Öğretim elemanı yalnızca istisna talebi açabilir; değiştirme işlemi yeni bir denetim olayı üretir.

## API sözleşmesi

- `POST /api/sessions` — öğretim elemanı yetkisiyle ders oturumu açar.
- `POST /api/sessions/:id/challenges` — sunucu içi QR challenge üretir.
- `POST /api/attendance/claim` — `{ challenge, webauthnAssertion }`; yalnızca SSO oturumundan öğrenci alınır.
- `POST /api/sessions/:id/close` — oturumu kapatır.

Her mutasyon: CSRF koruması, oran sınırlama, idempotency anahtarı, sunucu zamanı ve denetim olayı kullanmalıdır. Şema için [db/schema.sql](db/schema.sql) dosyasına bakın.
