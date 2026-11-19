# تشغيل أونلاين Fracas 2027.exe مع أصدقائك عبر الإنترنت

لعبة **Fracas 2027.exe** تدعم اللعب الأونلاين بطريقتين:

## الطريقة 1: سيرفر سحابي مجاني (أفضل طريقة — كود غرفة 4 حروف فقط زي Among Us!)
1. ارفع مجلد `FRACAS_2027_Desktop` على GitHub (خاص أو عام).
2. ادخل على [Render.com](https://render.com) → **New + → Blueprint** واختر المستودع (ملف `render.yaml` جاهز ومضبوط على منطقة **Frankfurt** القريبة للشرق الأوسط ومصر!).
3. سيعطيك رابط مثل: `https://fracas-2027-online.onrender.com`.
4. افتح **Fracas 2027.exe** → **Play Online** → اكتب الرابط في خانة **Online Server** (يُحفظ تلقائياً!).
   - أو ضعه مرة واحدة في `src/config.js` داخل `DEFAULT_ONLINE_SERVER` ثم نفّذ `npm run build:exe` لتبعت لأصحابك ملف `.exe` متصل بالسيرفر تلقائياً بدون كتابة أي رابط!
5. أنت تضغط **Create Room** → يظهر كود من 4 حروف (مثلاً `K7MP`) → أصحابك يكتبون الـ 4 حروف فقط ويدخلون معك فوراً!

## الطريقة 2: لعب محلي (LAN / Wi-Fi / Radmin VPN / ZeroTier)
- اترك خانة **Online Server** فارغة واضغط **Create Room (Host)**.
- سيظهر لك عنوان جهازك (مثل `192.168.1.8:8128`).
- أصحابك على نفس الواي فاي (أو على Radmin VPN / ZeroTier) يكتبون عنوان جهازك في **Online Server** + كود الغرفة الـ 4 حروف ويدخلون فوراً!

## تحسين الاتصال على شبكات الموبايل (اختياري — TURN Server)
إذا أردت نجاح اتصال P2P المباشر حتى على شبكات 4G/5G المغلقة، أضف متغيرات البيئة التالية على Render / Fly.io (من خدمة مجانية مثل Metered أو Cloudflare Calls):
- `TURN_URL`
- `TURN_USER`
- `TURN_PASS`
