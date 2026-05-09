export const DEMO_CATEGORIES = [
  {
    key: "college",
    name: "大专",
    group: "学历层级",
    description: "适合高职高专阶段常见阅读和写作场景。",
  },
  {
    key: "undergraduate",
    name: "本科",
    group: "学历层级",
    description: "适合本科通识英语与学术阅读。",
  },
  {
    key: "science",
    name: "理工英语",
    group: "专业领域",
    description: "偏理工、实验、工程与技术语境。",
  },
  {
    key: "humanities",
    name: "人文英语",
    group: "专业领域",
    description: "偏社会、人文、文化与写作语境。",
  },
];

export const DEMO_WORDS = [
  {
    term: "analysis",
    meaning: "分析；解析",
    example: "Careful analysis of the data revealed a clear pattern.",
    notes: "常见于学术写作与实验报告。",
    categoryKeys: ["college", "undergraduate", "science", "humanities"],
  },
  {
    term: "hypothesis",
    meaning: "假设；假说",
    example: "The experiment was designed to test the hypothesis.",
    notes: "理工和学术论文常见词。",
    categoryKeys: ["undergraduate", "science"],
  },
  {
    term: "molecule",
    meaning: "分子",
    example: "A water molecule contains two hydrogen atoms and one oxygen atom.",
    notes: "典型理工英语词汇。",
    categoryKeys: ["college", "science"],
  },
  {
    term: "interpret",
    meaning: "解释；理解",
    example: "Students should learn to interpret charts and tables accurately.",
    notes: "阅读理解和写作里都很常用。",
    categoryKeys: ["college", "undergraduate", "humanities"],
  },
  {
    term: "narrative",
    meaning: "叙述；叙事文",
    example: "The author uses a personal narrative to introduce the topic.",
    notes: "人文英语、写作课程常见。",
    categoryKeys: ["undergraduate", "humanities"],
  },
  {
    term: "archive",
    meaning: "档案；存档",
    example: "The library plans to archive rare historical materials.",
    notes: "既可作名词，也可作动词。",
    categoryKeys: ["college", "humanities"],
  },
  {
    term: "sustainable",
    meaning: "可持续的",
    example: "The city is developing a sustainable energy plan.",
    notes: "跨专业高频词。",
    categoryKeys: ["undergraduate", "science", "humanities"],
  },
  {
    term: "curriculum",
    meaning: "课程体系；课程设置",
    example: "The new curriculum emphasizes communication skills.",
    notes: "教育类和校园类文本常见。",
    categoryKeys: ["college", "undergraduate", "humanities"],
  },
];