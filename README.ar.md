# OpenCode · جسر التصميم إلى Adobe XD — الإصدار 2.0

**جسر MCP محلي يمنح وكيل الذكاء الاصطناعي القدرة على بناء مستندات Adobe XD حقيقية قابلة للتعديل، بما في ذلك إنشاء روابط النماذج التفاعلية (Prototype) التي يرفض واجهة إضافات XD إنشاءها — مع طبقة ذكاء للأصول التصميمية: الأيقونات، الخطوط وأنماط المكوّنات.**

[English README](README.md)

---

## ما هذا المشروع؟

معظم تكاملات "الذكاء الاصطناعي + أدوات التصميم" تتوقف عند توليد HTML/CSS أو نصوص
وصفية. هذا المشروع يفعل العكس: كل قرار تصميمي يصبح **عقدة حقيقية في شجرة مشهد XD**
(Scenegraph) — مستطيلات، مسارات، نصوص، مجموعات — يستطيع المصمم فتحها وتعديلها وتصديرها.

ثلاث قواعد تحكم البنية:

1. **لا نجاح وهمي.** العملية المجدولة ليست عملية منفّذة. الجسر يبلّغ فقط بما فعله
   الإضافة فعلياً، مع قراءة النتيجة من المستند نفسه.
2. **لا تجاوز لـ XD.** أي كتابة تحدث داخل `application.editDocument` ولها إيماءة
   مستخدم حقيقية من اللوحة. الإضافة لا تستطيع تعديل الملف بصمت.
3. **لا ادعاء بشأن حدود المنصّة.** حيث توجد حدود صلبة في واجهة XD العامة
   (روابط النماذج، مكوّنات رئيسية، تدرّج على النص) يستخدم الجسر بديلاً موثّقاً —
   Windows UI Automation لقيادة واجهة XD — أو يقول بصراحة إنه لا يستطيع.

---

## الجديد في الإصدار 2.0

| المحور | 1.x | 2.0 |
|---|---|---|
| روابط النماذج التفاعلية | قراءة وتحقق فقط | `xd_create_prototype_interaction` و `xd_create_prototype_graph` عبر Windows UI Automation، وكل رابط يُثبَت بقراءة من الإضافة |
| تنفيذ اللوحة | يدوي | `xd_pending_status` / `xd_apply_pending` / `xd_verify_pending` تضغط زر Apply الحقيقي وتؤكّد `batchExecuted` |
| سلامة التعديلات | جزئية | عقود تحقق لـ `move_node` و `resize_node` و `reparent_node` و `update_node`؛ خطأ `MUTATION_VERIFICATION_FAILED` بدل النجاح الصامت |
| الشاشات | عقدة واحدة لكل نداء | `xd_create_screen` يبني شاشة كاملة في معاملة واحدة (Undo واحد) |
| استكشاف القدرات | لا يوجد | `xd_get_capabilities` و `xd_get_prototype_grammar` و `xd_probe_xd_automation` |
| التثبيت | يدوي وخاص بجهاز واحد | `install.ps1` + وكيل `design` و7 مهارات مرفقة |
| عدد الأدوات | 72 | **78** |
| الاختبارات | 196 | **320** |

---

## المتطلبات

### البرامج

| المكوّن | الحد الأدنى | ملاحظات |
|---|---|---|
| **Windows** | 10 21H2 / 11 | Windows UI Automation مطلوبة لإنشاء الروابط ولزر Apply |
| **Adobe XD** | 61.x | نسخة MSIX أو Creative Cloud، كلتاهما تعمل |
| **UXP Developer Tool** | حديث | مرة واحدة فقط لتحميل الإضافة |
| **Node.js** | ≥ 22.6 | تشغيل TypeScript مباشرةً — بدون خطوة بناء |
| **OpenCode** | حديث | يجب أن يدعم سيرفرات MCP المحلية و Code Mode |
| **PowerShell** | 5.1+ (يُفضّل 7) | عامل UIA مكتوب بـ PowerShell |
| Git | أي إصدار | للاستنساخ والتحديث |

الاعتمادية الوحيدة وقت التشغيل: `ws`.

### ما يحتاجه OpenCode تحديداً

هذا هو الجزء الذي يغفله معظم المستخدمين. الجسر **سيرفر MCP محلي**، وبقية
الإعداد هي ما يجعل الوكيل مفيداً فعلاً:

| المتطلب | لماذا | من يثبّته |
|---|---|---|
| **تسجيل سيرفر MCP** في `~/.config/opencode/opencode.json` تحت `mcp.servers["adobe-xd"]` | بدونه لا تظهر الأدوات في الجلسة إطلاقاً | `install.ps1` أو يدوياً |
| **مسار Node مطلق** داخل `command` | OpenCode يشغّل السيرفر من بيئته الخاصة، وقد لا يجد `node` المجرّد | `install.ps1` يحلّه عبر `Get-Command node` |
| **ضبط `cwd` على مجلد `bridge/`** | الاستيرادات النسبية و`.bridge-token` والسجلات والتصدير تعتمد عليه | `install.ps1` |
| **مهلة تنفيذ طويلة** (`600000` مللي) | إنشاء رسم نموذج تفاعلي يقود الواجهة رابطاً برابط | الإعداد الافتراضي |
| **وكيل `design`** في `~/.config/opencode/agents/design.md` | يحمل عقد التنفيذ: "مجدول ≠ منفّذ"، مستويات التحقق، شروط التوقف | مرفق في `agents/` |
| **المهارات السبع** في `~/.config/opencode/skills/` | `adobe-xd-specialist` مرجع واجهة XD، والبقية للتجربة والرموز والتوجيه البصري وفحص الجودة والنماذج وإمكانية الوصول | مرفقة في `skills/` |
| **XD يعمل والإضافة محمّلة ومتصلة** | أدوات MCP لا حياة لها بدون الإضافة التي تحمل WebSocket | يدوي، مرة واحدة |
| **موديل يدعم الصور** (مُستحسن) | نقد اللقطات يحتاج رؤية PNG المصدَّر فعلاً | إعداد الموديل في OpenCode |

**غير مطلوب:** مفاتيح API، حسابات سحابية، إنترنت، Python. (بحث الأصول يستخدم
الشبكة عند توفرها، وبقية الأشياء تعمل بلا اتصال. Python يلزم فقط لمهارة
`ui-ux-pro-max` الاختيارية.)

---

## التثبيت (٥ دقائق)

### الطريقة أ — أمر واحد

```powershell
git clone https://github.com/greatomar/adobe-xd-design-bridge.git
cd adobe-xd-design-bridge
pwsh -File .\install.ps1
```

ما يفعله المثبّت:

1. يتحقق من Windows وNode ≥ 22.6 وAdobe XD و UXP Developer Tool؛
2. يثبّت الاعتمادية الوحيدة (`ws`) داخل `bridge/`؛
3. ينشئ `bridge/.bridge-token` إن لم يكن موجوداً؛
4. **ينسخ احتياطياً** `~/.config/opencode/opencode.json` ثم يدمج إعداد سيرفر
   `adobe-xd` (مع الحفاظ على بقية السيرفرات والإضافات)؛
5. ينسخ `agents/design.md` والمهارات إلى `~/.config/opencode/`؛
6. يطبع الخطوات اليدوية المتبقية: تحميل الإضافة، لصق الرمز، اختبار الدخان.

خيارات مفيدة:

| الخيار | الأثر |
|---|---|
| `-SkipOpenCodeConfig` | لا يلمس `opencode.json`، ويطبع الكتلة لتضيفها بنفسك |
| `-SkipSkills` | يثبّت الوكيل فقط دون المهارات |
| `-Force` | يستبدل ملفات الوكيل/المهارات الموجودة |

### الطريقة ب — يدوياً

```powershell
# 1) الاعتمادية والرمز
cd bridge
npm install
node bin\bridge.ts --show-token
```

```jsonc
// 2) ~/.config/opencode/opencode.json — دمج وليس استبدال
{
  "mcp": {
    "servers": {
      "adobe-xd": {
        "type": "local",
        "command": ["C:\\Program Files\\nodejs\\node.exe",
                    "C:\\path\\to\\adobe-xd-design-bridge\\bridge\\bin\\bridge.ts"],
        "cwd": "C:\\path\\to\\adobe-xd-design-bridge\\bridge",
        "environment": { "XD_BRIDGE_VERBOSE": "0" },
        "timeout": { "startup": 30000, "catalog": 30000, "execution": 600000 }
      }
    }
  }
}
```

```powershell
# 3) الوكيل والمهارات
Copy-Item agents\design.md $env:USERPROFILE\.config\opencode\agents\ -Force
Copy-Item skills\*        $env:USERPROFILE\.config\opencode\skills\ -Recurse -Force
```

**4) تحميل الإضافة (مرة واحدة).** افتح **Adobe UXP Developer Tool** ←
**Add Plugin** ← اختر `xd-plugin/manifest.json` ← **Load**. ثم في XD:
**Plugins ← Panels ← OpenCode Design Bridge**، الصق الرمز واضغط **Connect**.

### التحقق

أعد تشغيل OpenCode واختر وكيل **design**، ثم اطلب:

> شغّل `xd_health` ثم `xd_get_capabilities`.

المتوقع: `bridge.ok: true` و`xdConnected: true` بعد اتصال اللوحة، ثم اختبار الدخان:

> أنشئ لوحة رسم باسم `BridgeTest` بمقاس 390×844، أضف مستطيلاً ونصاً، ثم صدّرها.

يجب أن تظهر اللوحة في XD ويصل ملف PNG إلى `exports/`.

---

## كيف يستفيد OpenCode من الجسر

### ١) الأدوات تظهر بعد تشغيل سيرفر MCP فقط

تظهر الأدوات بصيغة `tools["adobe-xd"].xd_*` في Code Mode. إذا كانت الجلسة قد
بدأت قبل تعديل `opencode.json` فأعد تشغيل OpenCode — السيرفرات تُشغَّل عند بداية الجلسة.

### ٢) القراءة فورية، والكتابة تُجدول

| النداء | المعنى |
|---|---|
| `xd_create_rectangle` ← `{queued: true}` | الإضافة **تحتفظ** بالعمل. المستند لم يتغيّر بعد |
| زر **Apply** في اللوحة أو auto-apply | الإضافة تنفّذ الطابور داخل معاملة `editDocument` واحدة (Undo واحد) |
| `xd_get_operation_status` / `xd_verify_pending` | يثبت ما نُفّذ فعلاً |
| `xd_execute_batch` | شاشة كاملة في معاملة واحدة مع نتائج لكل عملية |

لا يبلّغ الجسر عن تعديل كمنفّذ دون قراءة تحقق. وإذا تجاهل المضيف الطلب تحصل على
`MUTATION_VERIFICATION_FAILED` لا على `ok: true`.

### ٣) إنشاء الروابط هو المسار الوحيد الذي يقود الواجهة

واجهة إضافات XD **للقراءة فقط** فيما يخص التفاعلات، لذا يقود الجسر واجهة XD نفسها
عبر Windows UI Automation:

- `xd_create_prototype_interaction` — رابط واحد (`source ← target`، tap، dissolve،
  المدة). لا يعيد `created: true` إلا مع `verified: true` من المستند.
- `xd_create_prototype_graph` — عدة روابط متسلسلة، كل واحدة متحقَّقة، مع
  `already_exists` و`conflict` وسياسات `fail_fast` / `continue_on_error`.
- `xd_validate_prototype_plan` — فحص مسبق للقراءة فقط يبلّغ كل العوائق قبل الإنشاء.
- `xd_get_prototype_grammar` — المجموعات القابلة للإنشاء فعلياً (trigger/action/transition).

قيود يجب معرفتها:

- لا يوجد في XD أي API لحذف التفاعلات، ولا لقراءة/كتابة اتجاه الانزلاق. حذف رابط
  أو تعديل مدته يبقى تعديلاً يدوياً داخل XD.
- عامل UIA يحتاج XD **ظاهراً وغير مقفول وبعيداً عن نافذة UAC**؛ يرفض العمل بدل
  الضغط الأعمى.
- رابط واحد لكل نداء — أداة الرسم تُسلسل وتتحقق من كل رابط.

### ٤) العمل التصميمي يُنفَّذ دفعات

`xd_execute_batch` هو المسار الموصى به لأي شيء أكبر من بضعة عقد: تنفيذ واحد في
اللوحة، Undo واحد، ونتائج لكل عملية. ثم يُصدَّر العمل للفحص البصري.

---

## سطح الأدوات (78 أداة)

| المجال | الأدوات |
|---|---|
| الاتصال والاستكشاف | `xd_health`, `xd_get_capabilities`, `xd_get_document_info`, `xd_get_artboards`, `xd_get_selection`, `xd_search_nodes`, `xd_inspect_node` |
| البناء | `xd_create_screen`, `xd_create_artboard`, `xd_create_rectangle`, `xd_create_ellipse`, `xd_create_line`, `xd_create_polygon`, `xd_create_path`, `xd_create_text`, `xd_create_image`, `xd_create_group`, `xd_create_mask_group` |
| المكوّنات | `xd_create_component`, `xd_create_component_variants` |
| التعديل | `xd_update_node`, `xd_update_text`, `xd_move_node`, `xd_resize_node`, `xd_rotate_node`, `xd_reparent_node`, `xd_duplicate_node`, `xd_delete_node`, `xd_ungroup`, `xd_arrange_nodes`, `xd_align_nodes`, `xd_distribute_nodes`, `xd_align_to_pixel_grid`, `xd_reset_3d_transforms` |
| الأنماط والأنظمة | `xd_apply_style`, `xd_apply_design_tokens`, `xd_set_layout`, `xd_set_constraints`, `xd_make_background`, `xd_replace_background` |
| المسارات | `xd_update_path`, `xd_convert_to_path`, `xd_outline_stroke` |
| التنفيذ | `xd_execute_batch`, `xd_execute_operation`, `xd_get_operation_status`, `xd_preview_operation`, `xd_pending_status`, `xd_apply_pending`, `xd_verify_pending` |
| النماذج التفاعلية | `xd_get_prototype_state`, `xd_validate_prototype`, `xd_get_prototype_grammar`, `xd_prototype_plan`, `xd_prototype_focus`, `xd_prototype_prepare`, `xd_prototype_verify`, `xd_create_prototype_interaction`, `xd_create_prototype_graph`, `xd_validate_prototype_plan`, `xd_probe_xd_automation` |
| الفحص والإخراج | `xd_audit_screen`, `xd_inspect_design_consistency`, `xd_validate_document`, `xd_export_artboard`, `xd_export_selection`, `xd_capture_design_preview` |
| الأصول (9) | `design_asset_search`, `design_asset_inspect`, `design_asset_get`, `design_asset_license`, `design_asset_recommend`, `design_asset_insert`, `design_asset_apply_font`, `design_asset_list_sources`, `design_asset_list_categories` |
| السياق (2) | `design_context_get`, `design_context_set` |

---

## بنية المشروع

```
bridge/                سيرفر MCP (TypeScript يعمل مباشرة على Node)
  bin/bridge.ts        نقطة الدخول (--show-token, --mock)
  src/tools.ts         78 أداة MCP
  src/operations.ts    سجل العمليات الموثّق والمتحقَّق
  src/automation/      عميل Windows UI Automation والقواعد والفحص المسبق
  src/assets/          السجل والمصادر والبحث والتخزين وSVG والسياق
xd-plugin/             لوحة UXP: manifest, ops.js, executor.js, main.js, index.html
automation/            عامل UIA بـ PowerShell + أدلة تشغيل حقيقية
agents/design.md       وكيل التصميم في OpenCode (عقد التنفيذ)
skills/                7 مهارات أصلية (XD، UX، الرموز، الاتجاه البصري، الجودة، النماذج، الوصول)
tests/                 اختبارات node:test (بلا شبكة، حتمية)
docs/                  المخططات ومصفوفة القدرات والأتمتة والعقود
install.ps1            المثبّت
```

---

## الاختبارات

```powershell
cd bridge
node --test --test-timeout=60000 ..\tests\
```

**320/320 ناجحة** (Node 26، حوالي 11 ثانية، بلا اتصال): البروتوكول، تسجيل الأدوات،
التحقق من الوسائط، معالجات الإضافة مقابل بيئة XD وهمية، منفّذ الدفعات، أتمتة
النماذج (القواعد، الفحص المسبق، الدفعات، Apply، السياسات)، عقود التعديل، وطبقة الأصول.

---

## استكشاف الأخطاء (مختصر)

| العرض | السبب | الحل |
|---|---|---|
| لا توجد أدوات `adobe-xd` | السيرفر غير مسجّل أو الجلسة بدأت قبل التعديل | تحقق من `opencode.json` وأعد التشغيل |
| `xdConnected: false` | اللوحة غير محمّلة أو غير متصلة | UDT ← Load ← الصق الرمز ← Connect |
| `EADDRINUSE 27183` | جسر آخر يعمل | أغلق الجلسة الأخرى أو غيّر `XD_BRIDGE_PORT` |
| العمليات تبقى `queued` | XD يطلب إيماءة من اللوحة | اضغط **Apply N** أو فعّل auto-apply |
| أدوات UIA تفشل | XD مصغّر أو مقفول أو خلف UAC | أظهر XD وأزل القفل ثم أعد المحاولة |

---

## الأمان

- **محلي فقط** — WebSocket على `127.0.0.1` مع رمز مصادقة (`.bridge-token`، صلاحيات
  0600، مستثنى من git).
- **قائمة بيضاء** — العمليات تُتحقق مقابل سجل مخططات؛ لا كود أو مسارات أو روابط حرة.
- **لا تعديل في الخلفية** — XD يفرض إيماءة مستخدم لكل كتابة.
- **لا كشط** — الأصول تأتي من واجهات موثّقة أو للاستخدام المرجعي فقط.
- **الأسرار مستثناة** — الرموز والسجلات والتصدير والتخزين المؤقت.

---

## بيئة الاختبار وترخيص Adobe

تم التطوير والاختبار على:

- Windows 11، Adobe XD **61.0.12.1** (MSIX)، UXP Developer Tool حديث،
  Node 26، OpenCode مع Code Mode.

**بخصوص تفعيل Adobe:** في بيئة المؤلف المحلية تم تفعيل استحقاق Creative Cloud
باستخدام **GenP v4.2.1**. هذا وصف للجهاز الذي جُرِّب عليه المشروع وليس توصية:
المستودع **لا يحتوي** أي برامج Adobe ولا أي أداة تفعيل ولا بيانات ترخيص ولا روابط
لها. الجسر يتحدث فقط مع نسخة XD المثبّتة مسبقاً عبر `127.0.0.1`.

أنت مسؤول عن امتلاك الترخيص الذي يتطلبه استخدامك لـ Adobe XD. وإذا أردت مستنداً
خالياً من هذه الملاحظة فاحذف هذا القسم — لا يعتمد عليه أي كود.

---

## الترخيص

MIT © 2026 greatomar — انظر [LICENSE](LICENSE).

الأصول الخارجية **غير** مرفقة. مجموعات الأيقونات والخطوط تحتفظ بتراخيصها
(ISC, MIT, Apache-2.0, CC0, OFL) وهي مسجّلة لكل أصل وتظهر عبر `design_asset_license`.
