export const DEMO_CATEGORIES = [
  {
    key: "college",
    name: "大专",
    description: "适合高职高专阶段常见阅读和写作场景。",
  },
  {
    key: "undergraduate",
    name: "本科",
    description: "适合本科通识英语与学术阅读。",
  },
  {
    key: "science",
    name: "理工英语",
    description: "偏理工、实验、工程与技术语境。",
  },
  {
    key: "humanities",
    name: "人文英语",
    description: "偏社会、人文、文化与写作语境。",
  },
];

export const DEMO_WORDS = [
  {
    term: "analysis",
    phonetics: ["/əˈnæləsɪs/"],
    meaning: "分析；解析",
    examples: [
      {
        en: "Careful analysis of the data revealed a clear pattern.",
        zh: "对数据进行仔细分析后，发现了一个清晰的规律。",
      },
    ],
    categoryKeys: ["college", "undergraduate", "science", "humanities"],
  },
  {
    term: "hypothesis",
    phonetics: ["/haɪˈpɒθəsɪs/"],
    meaning: "假设；假说",
    examples: [
      {
        en: "The experiment was designed to test the hypothesis.",
        zh: "该实验旨在验证这个假设。",
      },
    ],
    categoryKeys: ["undergraduate", "science"],
  },
  {
    term: "molecule",
    phonetics: ["/ˈmɒlɪkjuːl/"],
    meaning: "分子",
    examples: [
      {
        en: "A water molecule contains two hydrogen atoms and one oxygen atom.",
        zh: "一个水分子由两个氢原子和一个氧原子组成。",
      },
    ],
    categoryKeys: ["college", "science"],
  },
  {
    term: "interpret",
    phonetics: ["/ɪnˈtɜːprɪt/"],
    meaning: "解释；理解",
    examples: [
      {
        en: "Students should learn to interpret charts and tables accurately.",
        zh: "学生应该学会准确解读图表。",
      },
    ],
    categoryKeys: ["college", "undergraduate", "humanities"],
  },
  {
    term: "narrative",
    phonetics: ["/ˈnærətɪv/"],
    meaning: "叙述；叙事文",
    examples: [
      {
        en: "The author uses a personal narrative to introduce the topic.",
        zh: "作者用一段个人叙事来引入主题。",
      },
    ],
    categoryKeys: ["undergraduate", "humanities"],
  },
  {
    term: "archive",
    phonetics: ["/ˈɑːkaɪv/"],
    meaning: "档案；存档",
    examples: [
      {
        en: "The library plans to archive rare historical materials.",
        zh: "图书馆计划把珍贵的历史资料进行归档。",
      },
    ],
    categoryKeys: ["college", "humanities"],
  },
  {
    term: "sustainable",
    phonetics: ["/səˈsteɪnəbəl/"],
    meaning: "可持续的",
    examples: [
      {
        en: "The city is developing a sustainable energy plan.",
        zh: "这座城市正在制定一项可持续能源计划。",
      },
    ],
    categoryKeys: ["undergraduate", "science", "humanities"],
  },
  {
    term: "curriculum",
    phonetics: ["/kəˈrɪkjələm/"],
    meaning: "课程体系；课程设置",
    examples: [
      {
        en: "The new curriculum emphasizes communication skills.",
        zh: "新的课程体系强调沟通能力。",
      },
    ],
    categoryKeys: ["college", "undergraduate", "humanities"],
  },
];