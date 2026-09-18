import { NestFactory } from '@nestjs/core';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { AppModule } from '../src/app.module';
import {
  Question,
  QuestionType,
} from '../src/modules/questions/schemas/question.schema';

type SeedQuestion = {
  text: string;
  options?: string[];
  correctOptionIndex?: number;
  subject: string;
  topic: string;
  difficulty: number;
  explanation?: string;
  questionType: QuestionType;
};

const mcqQuestions: SeedQuestion[] = [
  // ─── ریاضی (۶ سوال) ───
  {
    text: 'حاصل عبارت ۲ + ۳ × ۴ برابر است با:',
    options: ['۱۴', '۲۰', '۱۱', '۲۴'],
    correctOptionIndex: 0,
    subject: 'ریاضی',
    topic: 'حساب',
    difficulty: 1,
    explanation: 'طبق ترتیب عملیات، اول ضرب: ۳×۴=۱۲ سپس ۲+۱۲=۱۴',
    questionType: QuestionType.MULTIPLE_CHOICE,
  },
  {
    text: 'ریشه‌های معادله x² − ۵x + ۶ = ۰ کدامند؟',
    options: ['۱ و ۶', '۲ و ۳', '−۲ و −۳', '۱ و −۶'],
    correctOptionIndex: 1,
    subject: 'ریاضی',
    topic: 'معادلات درجه دوم',
    difficulty: 2,
    explanation: 'x²−۵x+۶ = (x−۲)(x−۳) = ۰ → x=۲ یا x=۳',
    questionType: QuestionType.MULTIPLE_CHOICE,
  },
  {
    text: 'مشتق تابع f(x) = x³ + ۲x برابر است با:',
    options: ['۳x² + ۲', '۳x²', 'x² + ۲', '۳x + ۲'],
    correctOptionIndex: 0,
    subject: 'ریاضی',
    topic: 'مشتق',
    difficulty: 2,
    explanation: "d/dx(x³) = ۳x²، d/dx(۲x) = ۲",
    questionType: QuestionType.MULTIPLE_CHOICE,
  },
  {
    text: 'حاصل ∫ ۲x dx از ۰ تا ۱ برابر است با:',
    options: ['۰', '۱', '۲', '۱/۲'],
    correctOptionIndex: 1,
    subject: 'ریاضی',
    topic: 'انتگرال',
    difficulty: 3,
    explanation: '∫۲x dx = x²، از ۰ تا ۱ → ۱−۰ = ۱',
    questionType: QuestionType.MULTIPLE_CHOICE,
  },
  {
    text: 'اگر sin x = ۳/۵ و x در ربع اول باشد، cos x کدام است؟',
    options: ['۴/۵', '۳/۴', '۵/۴', '−۴/۵'],
    correctOptionIndex: 0,
    subject: 'ریاضی',
    topic: 'مثلثات',
    difficulty: 3,
    explanation: 'cos²x = ۱ − sin²x = ۱ − ۹/۲۵ = ۱۶/۲۵ → cos x = ۴/۵',
    questionType: QuestionType.MULTIPLE_CHOICE,
  },
  {
    text: 'حد lim(x→۰) sin x / x برابر است با:',
    options: ['۰', '۱', 'بی‌نهایت', 'تعریف نشده'],
    correctOptionIndex: 1,
    subject: 'ریاضی',
    topic: 'حد',
    difficulty: 4,
    explanation: 'حد مشهور مثلثاتی که مقدار آن ۱ است',
    questionType: QuestionType.MULTIPLE_CHOICE,
  },

  // ─── فیزیک (۵ سوال) ───
  {
    text: 'واحد اندازه‌گیری نیرو در SI کدام است؟',
    options: ['ژول', 'نیوتن', 'وات', 'پاسکال'],
    correctOptionIndex: 1,
    subject: 'فیزیک',
    topic: 'مکانیک',
    difficulty: 1,
    explanation: 'نیرو با نیوتن (N) اندازه‌گیری می‌شود',
    questionType: QuestionType.MULTIPLE_CHOICE,
  },
  {
    text: 'اگر جسمی با سرعت ثابت ۲۰ m/s به مدت ۵ ثانیه حرکت کند، مسافت طی‌شده چند متر است؟',
    options: ['۴ متر', '۲۵ متر', '۱۰۰ متر', '۴۰۰ متر'],
    correctOptionIndex: 2,
    subject: 'فیزیک',
    topic: 'حرکت',
    difficulty: 2,
    explanation: 'مسافت = سرعت × زمان = ۲۰ × ۵ = ۱۰۰ متر',
    questionType: QuestionType.MULTIPLE_CHOICE,
  },
  {
    text: 'کدام کمیت برداری است؟',
    options: ['جرم', 'دما', 'سرعت', 'زمان'],
    correctOptionIndex: 2,
    subject: 'فیزیک',
    topic: 'کمیت‌ها',
    difficulty: 2,
    explanation: 'سرعت هم اندازه دارد هم جهت، پس برداری است',
    questionType: QuestionType.MULTIPLE_CHOICE,
  },
  {
    text: 'انرژی جنبشی جسمی به جرم ۲ kg و سرعت ۳ m/s چند ژول است؟',
    options: ['۳', '۶', '۹', '۱۸'],
    correctOptionIndex: 2,
    subject: 'فیزیک',
    topic: 'انرژی',
    difficulty: 3,
    explanation: 'K = ½mv² = ½ × ۲ × ۹ = ۹ ژول',
    questionType: QuestionType.MULTIPLE_CHOICE,
  },
  {
    text: 'مقاومت معادل دو مقاومت ۶Ω و ۳Ω که موازی بسته شده‌اند چند اهم است؟',
    options: ['۹', '۲', '۳', '۱۸'],
    correctOptionIndex: 1,
    subject: 'فیزیک',
    topic: 'الکتریسیته',
    difficulty: 3,
    explanation: '۱/R = ۱/۶ + ۱/۳ = ۱/۲ → R = ۲Ω',
    questionType: QuestionType.MULTIPLE_CHOICE,
  },

  // ─── شیمی (۵ سوال) ───
  {
    text: 'عدد اتمی اکسیژن کدام است؟',
    options: ['۶', '۷', '۸', '۱۶'],
    correctOptionIndex: 2,
    subject: 'شیمی',
    topic: 'ساختار اتم',
    difficulty: 1,
    explanation: 'اکسیژن ۸ پروتون دارد، پس عدد اتمی ۸ است',
    questionType: QuestionType.MULTIPLE_CHOICE,
  },
  {
    text: 'فرمول شیمیایی اسید سولفوریک کدام است؟',
    options: ['HCl', 'H₂SO₄', 'HNO₃', 'H₂CO₃'],
    correctOptionIndex: 1,
    subject: 'شیمی',
    topic: 'ترکیبات',
    difficulty: 1,
    explanation: 'اسید سولفوریک H₂SO₄ است',
    questionType: QuestionType.MULTIPLE_CHOICE,
  },
  {
    text: 'کدام یک پیوند کووالانسی است؟',
    options: ['NaCl', 'H₂O', 'KBr', 'MgO'],
    correctOptionIndex: 1,
    subject: 'شیمی',
    topic: 'پیوند',
    difficulty: 2,
    explanation: 'H₂O بین دو نافلز است و پیوند کووالانسی دارد',
    questionType: QuestionType.MULTIPLE_CHOICE,
  },
  {
    text: 'pH محلولی با غلظت [H⁺] = ۱۰⁻³ مولار چند است؟',
    options: ['۳', '−۳', '۱۱', '۷'],
    correctOptionIndex: 0,
    subject: 'شیمی',
    topic: 'اسید و باز',
    difficulty: 3,
    explanation: 'pH = −log[H⁺] = −log(۱۰⁻³) = ۳',
    questionType: QuestionType.MULTIPLE_CHOICE,
  },
  {
    text: 'در واکنش ۲H₂ + O₂ → ۲H₂O، اگر ۴ مول H₂ مصرف شود، چند مول آب تولید می‌شود؟',
    options: ['۲', '۴', '۶', '۸'],
    correctOptionIndex: 1,
    subject: 'شیمی',
    topic: 'استوکیومتری',
    difficulty: 3,
    explanation: 'نسبت مولی H₂ به H₂O برابر ۱:۱ است، پس ۴ مول آب تولید می‌شود',
    questionType: QuestionType.MULTIPLE_CHOICE,
  },

  // ─── زیست (۵ سوال) ───
  {
    text: 'واحد ساختاری و عملکردی موجودات زنده چیست؟',
    options: ['بافت', 'سلول', 'اندام', 'مولکول'],
    correctOptionIndex: 1,
    subject: 'زیست',
    topic: 'سلول',
    difficulty: 1,
    explanation: 'سلول کوچک‌ترین واحد زنده است',
    questionType: QuestionType.MULTIPLE_CHOICE,
  },
  {
    text: 'کدام اندامک مسئول تولید انرژی در سلول است؟',
    options: ['ریبوزوم', 'میتوکندری', 'گلژی', 'لیزوزوم'],
    correctOptionIndex: 1,
    subject: 'زیست',
    topic: 'اندامک‌ها',
    difficulty: 1,
    explanation: 'میتوکندری نیروگاه سلول است',
    questionType: QuestionType.MULTIPLE_CHOICE,
  },
  {
    text: 'فرآیند فتوسنتز در کدام اندامک انجام می‌شود؟',
    options: ['میتوکندری', 'کلروپلاست', 'ریبوزوم', 'هسته'],
    correctOptionIndex: 1,
    subject: 'زیست',
    topic: 'فتوسنتز',
    difficulty: 2,
    explanation: 'فتوسنتز در کلروپلاست انجام می‌شود',
    questionType: QuestionType.MULTIPLE_CHOICE,
  },
  {
    text: 'در انسان، تعداد کروموزوم‌های سلول پیکری چند است؟',
    options: ['۲۳', '۴۶', '۹۲', '۲۲'],
    correctOptionIndex: 1,
    subject: 'زیست',
    topic: 'ژنتیک',
    difficulty: 2,
    explanation: '۲۳ جفت = ۴۶ کروموزوم',
    questionType: QuestionType.MULTIPLE_CHOICE,
  },
  {
    text: 'آنزیم اصلی همانندسازی DNA کدام است؟',
    options: ['RNA پلیمراز', 'DNA پلیمراز', 'لیگاز', 'هلیکاز'],
    correctOptionIndex: 1,
    subject: 'زیست',
    topic: 'همانندسازی',
    difficulty: 4,
    explanation: 'DNA پلیمراز آنزیم اصلی سنتز رشته جدید است',
    questionType: QuestionType.MULTIPLE_CHOICE,
  },

  // ─── ادبیات (۳ سوال) ───
  {
    text: 'آرایه ادبی در عبارت «چشم روزگار» کدام است؟',
    options: ['تشبیه', 'استعاره', 'کنایه', 'مجاز'],
    correctOptionIndex: 1,
    subject: 'ادبیات',
    topic: 'آرایه‌های ادبی',
    difficulty: 3,
    explanation: 'روزگار به انسان تشبیه شده و «چشم» به آن نسبت داده شده → استعاره',
    questionType: QuestionType.MULTIPLE_CHOICE,
  },
  {
    text: 'قالب شعری مثنوی کدام ویژگی را دارد؟',
    options: [
      'قافیه یکسان در همه ابیات',
      'قافیه مستقل در هر بیت',
      'قافیه در بیت اول و بعد یکسان',
      'بدون قافیه',
    ],
    correctOptionIndex: 1,
    subject: 'ادبیات',
    topic: 'قالب‌های شعری',
    difficulty: 3,
    explanation: 'در مثنوی هر بیت قافیه مستقل دارد (aa bb cc ...)',
    questionType: QuestionType.MULTIPLE_CHOICE,
  },
  {
    text: 'کدام گزینه از آثار سعدی است؟',
    options: ['شاهنامه', 'گلستان', 'خمسه', 'مثنوی معنوی'],
    correctOptionIndex: 1,
    subject: 'ادبیات',
    topic: 'آثار ادبی',
    difficulty: 2,
    explanation: 'گلستان و بوستان از سعدی شیرازی است',
    questionType: QuestionType.MULTIPLE_CHOICE,
  },

  // ─── عربی (۳ سوال) ───
  {
    text: 'جمع مکسر کلمه «کتاب» کدام است؟',
    options: ['کتب', 'کتابون', 'کتابات', 'کاتبان'],
    correctOptionIndex: 0,
    subject: 'عربی',
    topic: 'صرف',
    difficulty: 2,
    explanation: 'کتاب جمع مکسرش «کتب» است',
    questionType: QuestionType.MULTIPLE_CHOICE,
  },
  {
    text: 'ترجمه صحیح «ذهب الطالب إلی المدرسة» کدام است؟',
    options: [
      'دانش‌آموز به مدرسه رفت',
      'دانش‌آموز در مدرسه است',
      'دانش‌آموز مدرسه را دید',
      'دانش‌آموز از مدرسه آمد',
    ],
    correctOptionIndex: 0,
    subject: 'عربی',
    topic: 'ترجمه',
    difficulty: 2,
    explanation: '«ذهب» فعل ماضی به معنی رفت و «إلی» به معنی به سوی',
    questionType: QuestionType.MULTIPLE_CHOICE,
  },
  {
    text: 'اعراب کلمه «مدرسة» در جمله «ذهبتُ إلی المدرسةِ» چیست؟',
    options: ['مرفوع', 'منصوب', 'مجرور', 'مجزوم'],
    correctOptionIndex: 2,
    subject: 'عربی',
    topic: 'نحو',
    difficulty: 4,
    explanation: 'بعد از حرف جر «إلی» اسم مجرور می‌شود',
    questionType: QuestionType.MULTIPLE_CHOICE,
  },

  // ─── دین و زندگی (۲ سوال) ───
  {
    text: 'تعداد رکعات نماز مغرب چند است؟',
    options: ['۲', '۳', '۴', '۵'],
    correctOptionIndex: 1,
    subject: 'دینی',
    topic: 'احکام',
    difficulty: 1,
    explanation: 'نماز مغرب ۳ رکعت است',
    questionType: QuestionType.MULTIPLE_CHOICE,
  },
  {
    text: 'کدام یک از اصول دین نیست؟',
    options: ['توحید', 'نبوت', 'معاد', 'نماز'],
    correctOptionIndex: 3,
    subject: 'دینی',
    topic: 'اعتقادات',
    difficulty: 2,
    explanation: 'نماز از فروع دین است، نه اصول',
    questionType: QuestionType.MULTIPLE_CHOICE,
  },

  // ─── زبان انگلیسی (۱ سوال) ───
  {
    text: 'Choose the correct sentence:',
    options: [
      'She go to school every day.',
      'She goes to school every day.',
      'She going to school every day.',
      'She gone to school every day.',
    ],
    correctOptionIndex: 1,
    subject: 'انگلیسی',
    topic: 'Grammar',
    difficulty: 2,
    explanation: 'با فاعل سوم شخص مفرد، فعل +s می‌گیرد',
    questionType: QuestionType.MULTIPLE_CHOICE,
  },
];

const textQuestions: SeedQuestion[] = [
  // ─── ریاضی (۶ سوال) ───
  {
    text: 'قضیه فیثاغورس را بیان کنید و یک مثال بزنید.',
    subject: 'ریاضی',
    topic: 'هندسه',
    difficulty: 2,
    explanation:
      'در مثلث قائم‌الزاویه، مربع وتر برابر مجموع مربع دو ضلع دیگر است: a² + b² = c². مثال: اگر دو ضلع ۳ و ۴ باشند، وتر ۵ است.',
    questionType: QuestionType.TEXT_ANSWER,
  },
  {
    text: 'مفهوم مشتق تابع را تعریف کنید.',
    subject: 'ریاضی',
    topic: 'مشتق',
    difficulty: 3,
    explanation:
      'مشتق تابع، آهنگ تغییر لحظه‌ای تابع نسبت به متغیر است و از حد نسبت تغییرات تابع به تغییرات متغیر وقتی تغییرات به صفر میل کند، به دست می‌آید.',
    questionType: QuestionType.TEXT_ANSWER,
  },
  {
    text: 'قاعده لاپیتال را توضیح دهید.',
    subject: 'ریاضی',
    topic: 'حد',
    difficulty: 4,
    explanation:
      'اگر حد تابعی به شکل ۰/۰ یا ∞/∞ باشد، حد تابع برابر حد نسبت مشتق صورت به مشتق مخرج است.',
    questionType: QuestionType.TEXT_ANSWER,
  },
  {
    text: 'تفاوت بین تصاعد حسابی و هندسی چیست؟',
    subject: 'ریاضی',
    topic: 'دنباله‌ها',
    difficulty: 3,
    explanation:
      'در تصاعد حسابی اختلاف هر دو جمله متوالی ثابت است، ولی در تصاعد هندسی نسبت هر دو جمله متوالی ثابت است.',
    questionType: QuestionType.TEXT_ANSWER,
  },
  {
    text: 'مفهوم لگاریتم را تعریف کنید.',
    subject: 'ریاضی',
    topic: 'لگاریتم',
    difficulty: 3,
    explanation:
      'log_a(b) برابر توانی است که پایه a باید به آن برسد تا b حاصل شود. یعنی اگر a^x = b، آنگاه x = log_a(b).',
    questionType: QuestionType.TEXT_ANSWER,
  },
  {
    text: 'قانون احتمال شرطی را بنویسید.',
    subject: 'ریاضی',
    topic: 'احتمال',
    difficulty: 4,
    explanation:
      'P(A|B) = P(A∩B) / P(B)، به شرطی که P(B) ≠ ۰.',
    questionType: QuestionType.TEXT_ANSWER,
  },

  // ─── فیزیک (۵ سوال) ───
  {
    text: 'قانون دوم نیوتن را بیان کنید.',
    subject: 'فیزیک',
    topic: 'مکانیک',
    difficulty: 2,
    explanation:
      'نیروی خالص وارد بر جسم برابر حاصل‌ضرب جرم در شتاب است: F = ma.',
    questionType: QuestionType.TEXT_ANSWER,
  },
  {
    text: 'تفاوت وزن و جرم چیست؟',
    subject: 'فیزیک',
    topic: 'مکانیک',
    difficulty: 2,
    explanation:
      'جرم مقدار ماده و ثابت است، ولی وزن نیروی گرانش وارد بر جسم است و به g محل بستگی دارد: W = mg.',
    questionType: QuestionType.TEXT_ANSWER,
  },
  {
    text: 'قانون بقای انرژی را توضیح دهید.',
    subject: 'فیزیک',
    topic: 'انرژی',
    difficulty: 3,
    explanation:
      'انرژی نه به وجود می‌آید و نه از بین می‌رود، فقط از شکلی به شکل دیگر تبدیل می‌شود.',
    questionType: QuestionType.TEXT_ANSWER,
  },
  {
    text: 'قانون اهم را بنویسید و هر یک از اجزای آن را توضیح دهید.',
    subject: 'فیزیک',
    topic: 'الکتریسیته',
    difficulty: 3,
    explanation:
      'V = IR؛ V اختلاف پتانسیل (ولت)، I جریان (آمپر)، R مقاومت (اهم).',
    questionType: QuestionType.TEXT_ANSWER,
  },
  {
    text: 'پدیده القای الکترومغناطیسی را توضیح دهید.',
    subject: 'فیزیک',
    topic: 'مغناطیس',
    difficulty: 5,
    explanation:
      'تغییر شار مغناطیسی عبوری از یک مدار، نیروی محرکه الکتریکی در آن القا می‌کند. این پدیده اساس کار ژنراتور و ترانسفورماتور است.',
    questionType: QuestionType.TEXT_ANSWER,
  },

  // ─── شیمی (۵ سوال) ───
  {
    text: 'تفاوت بین عنصر و ترکیب چیست؟',
    subject: 'شیمی',
    topic: 'مفاهیم پایه',
    difficulty: 2,
    explanation:
      'عنصر از یک نوع اتم ساخته شده، ولی ترکیب از دو یا چند نوع اتم که با نسبت ثابت با هم پیوند شیمیایی دارند.',
    questionType: QuestionType.TEXT_ANSWER,
  },
  {
    text: 'قانون پایستگی جرم را توضیح دهید.',
    subject: 'شیمی',
    topic: 'واکنش‌ها',
    difficulty: 2,
    explanation:
      'در یک واکنش شیمیایی در سیستم بسته، مجموع جرم مواد واکنش‌دهنده برابر مجموع جرم مواد فرآورده است.',
    questionType: QuestionType.TEXT_ANSWER,
  },
  {
    text: 'مفهوم مول را تعریف کنید.',
    subject: 'شیمی',
    topic: 'استوکیومتری',
    difficulty: 3,
    explanation:
      'مول مقدار ماده‌ای است که به تعداد عدد آووگادرو (۶/۰۲۲×۱۰²³) ذره دارد.',
    questionType: QuestionType.TEXT_ANSWER,
  },
  {
    text: 'تفاوت اسید و باز بر اساس نظریه آرنیوس چیست؟',
    subject: 'شیمی',
    topic: 'اسید و باز',
    difficulty: 3,
    explanation:
      'اسید آرنیوس ماده‌ای است که در آب یون هیدروژن (H⁺) آزاد می‌کند و باز ماده‌ای است که یون هیدروکسید (OH⁻) آزاد می‌کند.',
    questionType: QuestionType.TEXT_ANSWER,
  },
  {
    text: 'اصل لوشاتلیه را بیان کنید.',
    subject: 'شیمی',
    topic: 'تعادل',
    difficulty: 4,
    explanation:
      'اگر به یک سیستم در حال تعادل، تنشی وارد شود (تغییر دما، فشار یا غلظت)، سیستم تعادل خود را طوری جابه‌جا می‌کند که اثر آن تنش کاهش یابد.',
    questionType: QuestionType.TEXT_ANSWER,
  },

  // ─── زیست (۵ سوال) ───
  {
    text: 'تفاوت یاخته پروکاریوت و یوکاریوت چیست؟',
    subject: 'زیست',
    topic: 'سلول',
    difficulty: 3,
    explanation:
      'پروکاریوت‌ها هسته حقیقی ندارند و DNA آزاد در سیتوپلاسم است، ولی یوکاریوت‌ها هسته دارند و اندامک‌های غشادار دارند.',
    questionType: QuestionType.TEXT_ANSWER,
  },
  {
    text: 'مراحل میتوز را نام ببرید.',
    subject: 'زیست',
    topic: 'تقسیم سلولی',
    difficulty: 3,
    explanation:
      'پروفاز، متافاز، آنافاز، تلوفاز (و در برخی کتاب‌ها اینترفاز هم مقدمه ذکر می‌شود).',
    questionType: QuestionType.TEXT_ANSWER,
  },
  {
    text: 'قانون مندل اول را بیان کنید.',
    subject: 'زیست',
    topic: 'ژنتیک',
    difficulty: 3,
    explanation:
      'قانون تفکیک صفات: هر فرد برای هر صفت دو آلل دارد که هنگام تشکیل گامت از هم جدا می‌شوند.',
    questionType: QuestionType.TEXT_ANSWER,
  },
  {
    text: 'نقش ATP در سلول چیست؟',
    subject: 'زیست',
    topic: 'متابولیسم',
    difficulty: 2,
    explanation:
      'ATP حامل انرژی سلول است. با هیدرولیز آن به ADP و فسفات، انرژی آزاد می‌شود که صرف فرآیندهای سلولی می‌شود.',
    questionType: QuestionType.TEXT_ANSWER,
  },
  {
    text: 'تفاوت هورمون و آنزیم چیست؟',
    subject: 'زیست',
    topic: 'فیزیولوژی',
    difficulty: 3,
    explanation:
      'آنزیم کاتالیزور واکنش‌های شیمیایی است، ولی هورمون پیام‌رسان شیمیایی است که از غده ترشح شده و روی اندام هدف اثر می‌گذارد.',
    questionType: QuestionType.TEXT_ANSWER,
  },

  // ─── ادبیات (۳ سوال) ───
  {
    text: 'تفاوت تشبیه و استعاره را توضیح دهید.',
    subject: 'ادبیات',
    topic: 'آرایه‌های ادبی',
    difficulty: 3,
    explanation:
      'تشبیه صریح است و هر چهار رکن دارد (مشبه، مشبه‌به، ادات، وجه شبه). استعاره تشبیهی است که یکی از دو طرف آن حذف شده باشد.',
    questionType: QuestionType.TEXT_ANSWER,
  },
  {
    text: 'ویژگی‌های سبک خراسانی را نام ببرید.',
    subject: 'ادبیات',
    topic: 'سبک‌شناسی',
    difficulty: 4,
    explanation:
      'زبان ساده و روان، کم‌استفاده از آرایه، توصیف طبیعت، وزن و قافیه استوار، و کاربرد زیاد افعال ساده از ویژگی‌های این سبک است.',
    questionType: QuestionType.TEXT_ANSWER,
  },
  {
    text: 'تفاوت غزل و قصیده چیست؟',
    subject: 'ادبیات',
    topic: 'قالب‌های شعری',
    difficulty: 3,
    explanation:
      'غزل معمولاً ۵ تا ۱۲ بیت و موضوع عاشقانه دارد. قصیده بیش از ۲۰ بیت و موضوع مدح، وصف یا پند دارد. هر دو در بیت اول هم‌قافیه‌اند.',
    questionType: QuestionType.TEXT_ANSWER,
  },

  // ─── عربی (۳ سوال) ───
  {
    text: 'انواع فعل از نظر زمان در زبان عربی را نام ببرید.',
    subject: 'عربی',
    topic: 'صرف',
    difficulty: 3,
    explanation:
      'فعل ماضی (گذشته)، فعل مضارع (حال و آینده) و فعل امر (دستوری).',
    questionType: QuestionType.TEXT_ANSWER,
  },
  {
    text: 'تفاوت مبتدا و خبر را توضیح دهید.',
    subject: 'عربی',
    topic: 'نحو',
    difficulty: 3,
    explanation:
      'مبتدا اسمی است که جمله با آن آغاز می‌شود و مرفوع است. خبر بخشی است که درباره مبتدا اطلاع می‌دهد و آن هم مرفوع است.',
    questionType: QuestionType.TEXT_ANSWER,
  },
  {
    text: 'اعراب را در زبان عربی توضیح دهید.',
    subject: 'عربی',
    topic: 'نحو',
    difficulty: 4,
    explanation:
      'اعراب به تغییرات آخر کلمه بر اساس موقعیت آن در جمله اشاره دارد: مرفوع (ُ)، منصوب (َ)، مجرور (ِ)، مجزوم (ْ).',
    questionType: QuestionType.TEXT_ANSWER,
  },

  // ─── دینی (۲ سوال) ───
  {
    text: 'اصول دین را نام ببرید.',
    subject: 'دینی',
    topic: 'اعتقادات',
    difficulty: 2,
    explanation:
      'توحید، نبوت، معاد (و در شیعه: عدل و امامت هم جزء اصول هستند).',
    questionType: QuestionType.TEXT_ANSWER,
  },
  {
    text: 'فروع دین را نام ببرید.',
    subject: 'دینی',
    topic: 'احکام',
    difficulty: 3,
    explanation:
      'نماز، روزه، زکات، خمس، حج، جهاد، امر به معروف، نهی از منکر، تولی و تبری.',
    questionType: QuestionType.TEXT_ANSWER,
  },

  // ─── انگلیسی (۱ سوال) ───
  {
    text: 'Explain the difference between "Present Simple" and "Present Continuous" with examples.',
    subject: 'انگلیسی',
    topic: 'Grammar',
    difficulty: 3,
    explanation:
      'Present Simple for habits and facts (e.g., "I play football every day"). Present Continuous for actions happening now (e.g., "I am playing football right now").',
    questionType: QuestionType.TEXT_ANSWER,
  },
];

async function seed() {
  console.log('🌱 Starting seed process...');

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  const questionModel = app.get<Model<Question>>(
    getModelToken(Question.name),
  );

  const all = [...mcqQuestions, ...textQuestions];

  // پاک‌سازی اختیاری — اگه نمیخوای پاک کنی، کامنت کن
  await questionModel.deleteMany({});
  console.log('🗑️  Cleared existing questions');

  const inserted = await questionModel.insertMany(all);

  console.log(`✅ Inserted ${inserted.length} questions`);
  console.log(`   - MCQ:  ${mcqQuestions.length}`);
  console.log(`   - Text: ${textQuestions.length}`);

  await app.close();
  process.exit(0);
}

seed().catch((err) => {
  console.error('❌ Seed failed:', err);
  process.exit(1);
});