# Ankh bağımsız program arşivi

Ankh uygulamasına gömülmeyen, ayrı kurulan programların kataloğu. İlk program PhotoCraft.

- Resmi Mac/Windows paketleri değiştirilmeden kopyalanır; SHA-256 hem GitHub digest hem upstream SHA256SUMS ile doğrulanır.
- Bu arşivdeki paketler yeniden derlenmiş Ankh sürümleri değildir. Özgün imzalar korunur.
- Kaynak Git geçmişi her yeni kararlı sürümde `.bundle` dosyası olarak korunur. `git clone photocraft-source-v0.16.0.bundle photocraft` ile geri açılır. Bu bir web üzerinden kaynak gezilebilen fork değildir; Git bundle tam Git yedeğidir. LFS nesneleri/harici servisler/bağımlılıklar ayrıca korunmalıdır.
- `programs.json` arşivlenecek uygulamaları, `catalog.json` yalnız doğrulanıp yayımlanmış paketleri tutar.
- Actions → Program arşivini güncelle → Run workflow. Zamanlayıcı her gün yeni kararlı sürümü kontrol eder; her commit için derleme yapmaz. GitHub zamanlayıcıları gecikebilir veya hareketsiz depolarda durabilir; Actions sayfasını ara sıra kontrol et.
- Arşivlenen uygulamanın kendi güncelleme adresi değiştirilmez; PhotoCraft hâlâ resmi sürümlerini kontrol eder. Ankh kataloğu kendi arşivini gösterir. Kendi adınla derleme/imzalama ayrı bir çalışma gerektirir.

Programların lisans, NOTICE ve atıf dosyaları ilgili Release içinde korunur. Kaynak: https://github.com/storytold/photocraft
