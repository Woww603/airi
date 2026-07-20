/**
 * Reasons a Discord message is unsafe to send into the standalone model runtime.
 */
export type StandaloneDiscordInputSafetyReason
  = | 'credential-or-secret'
    | 'internal-data-request'
    | 'personal-identifier'
    | 'prompt-attack'

/**
 * Reasons a long-term memory card is unsafe to store.
 */
export type StandaloneDiscordMemorySafetyReason
  = | 'credential-or-secret'
    | 'exact-address'
    | 'internal-data-request'
    | 'payment-or-government-id'
    | 'personal-contact'
    | 'prompt-attack'
    | 'sensitive-identity'
    | 'third-party-private-fact'

/**
 * Reasons a Discord-authored durable memory does not prove current-user ownership.
 */
export type StandaloneDiscordMemorySubjectSafetyReason
  = | 'ambiguous-subject'
    | 'third-party-subject'

/**
 * Result of checking one Discord message before model generation.
 */
export interface StandaloneDiscordInputSafetyDecision {
  /** Whether the message is safe to send to the model. */
  safe: boolean
  /** Policy reason for unsafe messages. */
  reason?: StandaloneDiscordInputSafetyReason
}

/**
 * Result of checking one potential long-term memory card.
 */
export interface StandaloneDiscordMemorySafetyDecision {
  /** Whether the content can be stored as a long-term memory card. */
  safe: boolean
  /** Policy reason for unsafe memory content. */
  reason?: StandaloneDiscordMemorySafetyReason
}

/**
 * Result of checking both content safety and current-user subject ownership.
 */
export interface StandaloneDiscordSelfMemorySafetyDecision {
  /** Whether the content is safe and unambiguously describes the verified current Discord user. */
  safe: boolean
  /** Fixed policy category; never contains the candidate memory text. */
  reason?: StandaloneDiscordMemorySafetyReason | StandaloneDiscordMemorySubjectSafetyReason
}

const PROMPT_ATTACK_PATTERNS = [
  /\bignore (?:all )?(?:previous|above|earlier|system|developer|safety) (?:instructions|rules|messages)\b/i,
  /\b(?:forget|discard|override|bypass) (?:your|all|the )?(?:rules|instructions|system prompt|developer message|safety)\b/i,
  /\b(?:jailbreak|dan mode|developer mode|god mode|no policy|unfiltered|uncensored)\b/i,
  /\b(?:act as|pretend to be|roleplay as|simulate) (?:an? )?(?:unrestricted|uncensored|jailbroken|no[- ]?rules?)\b/i,
  /(?:base64|rot13|morse|encode|translate).*(?:system prompt|hidden rules|token|api key|memory|memories)/i,
  /忽略.*(?:之前|上面|系统|开发者|规则|指令|限制|安全)/,
  /(?:无视|绕过|覆盖|删除|关闭|禁用).*(?:规则|指令|系统提示|开发者消息|安全限制|过滤|限制)/,
  /(?:DAN|越狱|开发者模式|无限制模式|无审查|不受限制)/i,
  /(?:假装|角色扮演|扮演).*(?:不受限制|无限制|没有规则|可以绕过|管理员|开发者)/,
  /(?:base64|编码|翻译|摩斯|rot13).*(?:系统提示|隐藏规则|token|令牌|密钥|记忆)/i,
]

const INTERNAL_DATA_REQUEST_PATTERNS = [
  /\b(?:show|print|reveal|repeat|export|dump|leak|send|tell me) (?:(?:your|the|all)\s+)?(?:hidden )?(?:system prompts?|developer messages?|hidden rules|instructions|memory|memories|logs|config|configuration|token|api key|secrets?)\b/i,
  /\b(?:what are|list) (?:your|the) (?:hidden rules|system instructions|developer instructions|stored memories)\b/i,
  /(?:显示|透露|泄露|打印|导出|复述|说出|发给我|给我).*(?:系统提示|隐藏规则|开发者消息|后台配置|配置|日志|token|令牌|密钥|记忆|所有记忆)/,
  /(?:你的|当前|全部).*(?:系统提示|隐藏规则|开发者消息|后台配置|日志|token|令牌|密钥|记忆).*(?:是什么|给我|发我|导出|显示)/,
]

const CREDENTIAL_PATTERNS = [
  /\b(?:api[_ -]?key|password|secret)\s*(?:is|=|:)\s*\S{4,}/i,
  /\b(?:access|refresh|discord|bot)?[_ -]?token\s*(?:is|=|:)\s*\S{6,}/i,
  /\bbearer\s+[\w.-]{16,}\b/i,
  /\bsk-[\w-]{12,}\b/i,
  /\bxox[abpr]-[\w-]{12,}\b/i,
  /\b(?:DEEPSEEK_API_KEY|DISCORD_TOKEN|OPENAI_API_KEY)\b/i,
  /(?:密钥|令牌|密码|机器人令牌|访问令牌).{0,12}[是=:：].{4,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
]

const PERSONAL_CONTACT_PATTERNS = [
  /\b[\w.%+-]+@[\w.-]+\.[A-Z]{2,}\b/i,
  /\b(?:phone|mobile|cell|tel|wechat|telegram|whatsapp|email)\b.{0,24}\+?[\d\s().-]{7,}\b/i,
  /(?:手机号|手机号码|电话|微信|邮箱|邮件|联系方式).{0,24}[\w+@.\-\s]{6,}/,
]

const PAYMENT_OR_GOVERNMENT_ID_PATTERNS = [
  /\b(?:credit card|debit card|bank card|ssn|social security|passport|driver'?s license)\b.{0,32}[\w -]{6,}\b/i,
  /(?:银行卡|信用卡|身份证|护照|社保号|驾驶证).{0,32}[\w -]{6,}/,
  /\b(?:\d{4}[ -]){3}\d{4}\b/,
]

const EXACT_ADDRESS_PATTERNS = [
  /(?:home address|address|live at|lives at|street address).{0,48}\d{1,6}\s+\w[\w .'-]+/i,
  /\b\d{1,6}\s+[\p{L}\p{M}\d][\p{L}\p{M}\d .'-]{0,48}\s(?:avenue|ave|boulevard|blvd|court|ct|drive|dr|lane|ln|plaza|road|rd|street|st|way)\b/iu,
  /\b[\p{L}\p{M}\d][\p{L}\p{M}\d .'-]{0,48}\s(?:avenue|ave|boulevard|blvd|court|ct|drive|dr|lane|ln|plaza|road|rd|street|st|way)\s+(?:number\s+|no\.?\s*)\d{1,6}\b/iu,
  /(?:家庭住址|住址|地址|住在|家住|(?:[他她]们|[我他她])住在?|居住在?).*?(?:[路街巷弄号栋室楼]|单元|小区|公寓)/,
  /[\p{Script=Han}\p{L}\d]{1,32}(?:胡同|[路街巷弄道])\s*\d{1,6}(?:[号號栋棟室楼樓]|单元|單元)/u,
]

const SENSITIVE_IDENTITY_PATTERNS = [
  /\b(?:religion|political view|political affiliation|sexual orientation|diagnosis|medical history|disability)\b/i,
  /(?:宗教|信仰|政治立场|党派|性取向|病史|诊断|残疾|身份证明敏感信息)/,
]

const THIRD_PARTY_PRIVATE_FACT_PATTERNS = [
  /(?:remember|store|save).{0,40}(?:his|her|their|someone'?s|my friend'?s|my coworker'?s).{0,80}(?:phone|email|address|password|token|api key|secret|diagnosis)/i,
  /(?:记住|保存|记录).{0,40}(?:他|她|他们|别人|朋友|同事|老师|老板|室友|前任|妈妈|爸爸).{0,80}(?:手机号|邮箱|住址|密码|密钥|令牌|身份证|病史)/,
]

const SAFE_MEMORY_INTENT_PATTERNS = [
  /\b(?:please\s+)?remember(?:\s+(?:that|this))?\b/i,
  /\bcall me\b/i,
  /\bmy name is\b/i,
  /请?记住/,
  /请?记得/,
  /叫我/,
  /我叫/,
  /我的名字/,
]

// Discord-authored durable memory is deliberately narrower than normal chat.
// Relationship subjects describe another person even when introduced with
// first-person possession (for example, "my friend" or "我同事").
const THIRD_PARTY_SUBJECT_PATTERNS = [
  /\b(?:he|she|they|you|him|her|them|his|hers|their|theirs|your|yours|someone|somebody|another person)\b/i,
  /\b(?:we|our|ours|us|ourselves)\b/i,
  /\bi\s+(?:and|with|alongside)\s+(?:another\s+person|someone|somebody|[\p{L}\p{M}][\p{L}\p{M}'-]{1,48})\b/iu,
  /\b(?:my|our)\s+(?:(?:best|close|former|ex)\s+)?(?:assistant|aunt|baby|boss|boyfriend|brother|child|client|colleague|cousin|coworker|customer|daughter|doctor|employee|family|father|friend|girlfriend|grandfather|grandmother|grandparent|husband|manager|mentor|mother|neighbor|nephew|niece|parent|partner|physician|relative|roommate|sibling|sister|son|spouse|teacher|teammate|uncle|wife)(?:s|\s+s)?\b/i,
  /\bi\s+(?:am|care for|have|live with|work with)\s+(?:an?\s+|one\s+|two\s+|three\s+|\d+\s+|some\s+|the\s+)?(?:assistant|aunt|babies|baby|boss|boyfriend|brother|children|child|client|colleague|cousin|coworker|customer|daughter|doctor|employee|ex|family|father|friend|girlfriend|grandfather|grandmother|grandparent|husband|manager|mentor|mother|neighbor|nephew|niece|parent|partner|physician|relative|roommate|sibling|sister|son|spouse|teacher|teammate|uncle|wife)s?\b/i,
  /(?:我们|咱们|俺们|大家)/,
  /(?:我|俺|本人)[和与跟及同][\p{L}\p{M}]{1,48}/u,
  /(?:[他她它你您]|他们|她们|它们)(?:[的们住说想有是]|喜欢|偏好|工作|认为|觉得|使用)/,
  /(?:我|俺)的?(?:朋友|同事|医生|导师|助理|老板|上司|经理|伴侣|配偶|丈夫|妻子|男友|女友|室友|前任|家人|亲戚|姑姑|姨妈|叔叔|舅舅|祖母|外祖母|祖父|外祖父|奶奶|外婆|爷爷|外公|妈妈|母亲|爸爸|父亲|父母|兄弟|姐妹|孩子|宝宝|儿子|女儿|老师|客户|员工|队友|邻居)/,
  /(?:我|俺)(?:有|照顾|认识|喜欢|关心)(?:[一二两三]|\d+|几个|一些)?[个位名只]?(?:朋友|同事|医生|导师|助理|老板|上司|经理|伴侣|配偶|丈夫|妻子|男友|女友|室友|前任|家人|亲戚|姑姑|姨妈|叔叔|舅舅|祖母|外祖母|祖父|外祖父|奶奶|外婆|爷爷|外公|妈妈|母亲|爸爸|父亲|父母|兄弟|姐妹|孩子|宝宝|儿子|女儿|老师|客户|员工|队友|邻居)/,
  /(?:朋友|同事|医生|导师|助理|老板|上司|经理|伴侣|配偶|丈夫|妻子|男友|女友|室友|前任|家人|亲戚|姑姑|姨妈|叔叔|舅舅|祖母|外祖母|祖父|外祖父|奶奶|外婆|爷爷|外公|妈妈|母亲|爸爸|父亲|父母|兄弟|姐妹|孩子|宝宝|儿子|女儿|老师|客户|员工|队友|邻居)(?:[的说住想有是]|喜欢|偏好|工作|认为|觉得|使用)/,
]

const AMBIGUOUS_SUBJECT_PATTERNS = [
  /\b(?:i\s+(?:think|believe|heard|hear|know|remember|guess|was told)|according to|it is said)\b/i,
  /(?:^|\s)(?:我|本人|俺)(?:觉得|认为|听说|知道|记得|猜|被告知)/,
  /(?:据说|听人说|有人说|所说)/,
]

// These patterns describe only grammatical ownership. Predicate and value
// vocabulary remains open, so safe facts do not depend on an enumerated topic list.
const CURRENT_USER_ENGLISH_FRAME = /^(?:i\s+\S|my\s+\S|(?:please\s+)?call\s+me\s+\S)/iu
const CURRENT_USER_CHINESE_FRAME = /^(?:(?:我|俺|本人)(?!们)\S+|请?叫我\S+)/u
const HARD_SELF_CLAUSE_BOUNDARY = /[!?;:，。！？；：]+|[,.](?=\s|$)|\s+(?:although|because|but|if|since|unless|when|where|whereas|while)\s+|但是|然而|因为|由于|虽然|尽管/iu
const EXPLICIT_SUBJECT_COORDINATOR = /\s+(?:[Aa][Nn][Dd]|[Oo][Rr])\s+(?=(?:an?|he|i|my|she|they?|you)\b|[A-Z])/u
const FINITE_SUBJECT_COORDINATOR = /\s+(?:and|or)\s+(?=[\p{L}\p{M}][\p{L}\p{M}'-]{1,48}\s+(?:can|could|may|might|must|shall|should|will|would|[\p{L}\p{M}]{3,}(?:ed|s))\b)/iu

const OWNER_IMPERSONAL_ENGLISH_FRAME = /^(?:airi|application|bot|channel|character|dashboard|dm|installation|memory|policy|project|rule|runtime|server|system)\s+\S/iu
const OWNER_IMPERSONAL_CHINESE_FRAME = /^(?:此|本|当前)?(?:AIRI|机器人|项目|安装|服务器|频道|应用|系统|运行时|仪表盘|记忆|规则|策略|角色)\S+/u
const OWNER_IMPERATIVE_ENGLISH_FRAME = /^(?:allow|apply|avoid|block|disable|enable|follow|keep|limit|reply|require|respond|route|use)\s+\S/iu
const OWNER_IMPERATIVE_CHINESE_FRAME = /^(?:使用|保持|采用|应用|启用|禁用|避免|遵循|回复|回答|路由|限制|允许|阻止|要求)\S+/u

// Chinese has no casing boundary. This name shape is used only in a
// person-taking grammatical position, never as a general content blacklist.
const CHINESE_PERSON_NAME_SOURCE = String.raw`(?:[小老阿]\p{Script=Han}|[赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳鲍史唐费廉岑薛雷贺倪汤滕殷罗毕郝邬安常乐于傅皮卞齐康伍余元顾孟平黄和穆萧尹姚邵湛汪祁毛禹狄米贝明臧计伏成戴谈宋茅庞熊纪舒屈项祝董梁杜阮闵席季麻强贾路娄危江童颜郭梅盛林刁钟徐邱骆高夏蔡田樊胡凌霍虞万支柯管卢莫]\p{Script=Han}{1,2})`
const CURRENT_USER_CHINESE_PERSON_OBJECT = new RegExp(`^(?:我|俺|本人)(?:使用|信任|喜欢|认识)${CHINESE_PERSON_NAME_SOURCE}$`, 'u')
const CURRENT_USER_NON_HAN_PERSON_OBJECT = /^(?:我|俺|本人)(?:信任|喜欢|认识)\s*[\p{Lu}\p{Lt}][\p{L}\p{M}'-]{1,48}(?![\p{L}\p{M}])/u
const CHINESE_PERSON_RUN_ON = new RegExp(`(?<!的)${CHINESE_PERSON_NAME_SOURCE}(?:发呆|到达|工作|是|有|喜欢|认识|信任|跳舞)`, 'u')
const CHINESE_OWNER_ROLE_SUBJECT = new RegExp(`(?:负责人|管理员|创建者|成员|运营者|用户)是?${CHINESE_PERSON_NAME_SOURCE}`, 'u')

/**
 * Normalizes memory text for subject parsing while retaining visible structure.
 *
 * Before:
 * - "Ｍｙ timezone is Europe/Berlin"
 * - "I work on Carol’s project"
 *
 * After:
 * - visible: "My timezone is Europe/Berlin"
 * - canonical: "I work on Carol s project"
 */
function normalizeMemorySubjectText(value: string) {
  const visible = value.normalize('NFKC').replace(/\s+/g, ' ').trim()
  const canonical = visible
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return {
    canonical,
    visible,
  }
}

function hasUnsafeSubjectEncoding(value: string) {
  if (/\p{Cf}/u.test(value))
    return true

  return value
    .split(/\s+/u)
    .some(token => /\p{Script=Latin}/u.test(token) && /[\p{Script=Cyrillic}\p{Script=Greek}]/u.test(token))
}

function hasAmbiguousContainer(value: string) {
  const normalized = value.normalize('NFKC').trim()
  if (/[`"\u201C\u201D\u201E\u201F\u00AB\u00BB\u2039\u203A\u300C\u300D\u300E\u300F()[\]{}<>（）【】《》*|]/u.test(normalized))
    return true
  if (/__|~~|(?:^|[\s和与])\/[^/]+\/(?:$|\s)|(?:^|\s)\/|\/(?:$|\s)/u.test(normalized))
    return true
  if (/_[^_]+_|~[^~]+~|(?:^|\s)#{1,6}\s/u.test(normalized))
    return true
  if (/\p{Extended_Pictographic}/u.test(normalized))
    return true

  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index]
    if (character !== '\'' && character !== '\u2019' && character !== '\u2018' && character !== '\u201A' && character !== '\u201B' && character !== '\u00B4')
      continue

    const previous = normalized[index - 1] ?? ''
    const next = normalized[index + 1] ?? ''
    const isLatinWordApostrophe = /\p{Script=Latin}/u.test(previous)
      && /\p{Script=Latin}/u.test(next)
      && character !== '\u2018'
    if (!isLatinWordApostrophe)
      return true
  }

  return /(?:^|\s)>\s?/u.test(normalized)
}

function isCurrentUserFrame(canonical: string) {
  return CURRENT_USER_ENGLISH_FRAME.test(canonical)
    || CURRENT_USER_CHINESE_FRAME.test(canonical)
}

function hasOnlyCurrentUserFrames(value: string) {
  const rawClauses = value
    .split(HARD_SELF_CLAUSE_BOUNDARY)
    .flatMap(clause => clause.split(EXPLICIT_SUBJECT_COORDINATOR))
    .flatMap(clause => clause.split(FINITE_SUBJECT_COORDINATOR))
  let frameCount = 0
  for (const rawClause of rawClauses) {
    if (!rawClause.trim())
      continue

    const canonical = normalizeMemorySubjectText(rawClause).canonical
    if (!canonical || !isCurrentUserFrame(canonical))
      return false
    frameCount += 1
  }

  return frameCount > 0
}

function isOwnerFrame(canonical: string) {
  return OWNER_IMPERSONAL_ENGLISH_FRAME.test(canonical)
    || OWNER_IMPERSONAL_CHINESE_FRAME.test(canonical)
    || OWNER_IMPERATIVE_ENGLISH_FRAME.test(canonical)
    || OWNER_IMPERATIVE_CHINESE_FRAME.test(canonical)
}

function hasNamedParticipantReference(canonical: string) {
  const participant = /\b(?:(?:admire|hire|hired|know|like|love|met|miss|prefer|trust)\s+|(?:care|work)\s+for\s+)([\p{Lu}\p{Lt}][\p{L}\p{M}'-]{1,48})(?![\p{L}\p{M}])/gu
  const possessiveParticipant = /\b([\p{L}\p{M}][\p{L}\p{M}'-]{1,48})\s+s\b/giu
  const knownNonPersonParticipants = new Set(['airi', 'discord'])
  for (const match of [...canonical.matchAll(participant), ...canonical.matchAll(possessiveParticipant)]) {
    const name = match[1]
    if (name && !knownNonPersonParticipants.has(name.toLocaleLowerCase('en-US')) && !['it', 'that', 'this'].includes(name.toLocaleLowerCase('en-US')))
      return true
  }

  return false
}

function hasUnmarkedSecondSubject(canonical: string) {
  if (/^(?:i|my)(?:\s+\S+){3,}\s+(?!(?:and|as|at|for|from|in|of|on|or|the|to|with)\b)[\p{L}\p{M}][\p{L}\p{M}'-]{1,48}\s+(?:can|could|drank|may|might|must|shall|should|told|will|would|[\p{L}\p{M}]{3,}(?:ed|s))\s+\S+$/iu.test(canonical))
    return true

  return CURRENT_USER_CHINESE_PERSON_OBJECT.test(canonical)
    || CURRENT_USER_NON_HAN_PERSON_OBJECT.test(canonical)
    || CHINESE_PERSON_RUN_ON.test(canonical)
}

function hasAttributedThirdParty(canonical: string) {
  if (/\b(?:as|per)\s+[\p{Lu}\p{Lt}][\p{L}\p{M}'-]{1,48}(?![\p{L}\p{M}])/u.test(canonical))
    return true
  if (/\bfrom\s+[\p{Lu}\p{Lt}][\p{L}\p{M}'-]{1,48}(?![\p{L}\p{M}])/u.test(canonical) && !/^i\s+(?:am|come)\s+from\b/iu.test(canonical))
    return true

  return /\b(?:as|from|per)\s+[\p{L}\p{M}][\p{L}\p{M}'-]{1,48}\s+(?:an?|the)\s+(?:assistant|boss|child|client|colleague|coworker|customer|doctor|employee|friend|manager|mentor|parent|partner|teacher|teammate)\b/iu.test(canonical)
}

function hasOwnerRoleSubject(canonical: string) {
  if (/\b(?:administrator|admin|creator|member|moderator|operator|owner|user)\s+(?:are|has|have|is|was|were)\s+\S/iu.test(canonical))
    return true
  if (/^\p{L}+\s+[\p{Lu}\p{Lt}][\p{L}\p{M}'-]{1,48}\s+(?:has|is|was)\b/u.test(canonical))
    return true

  return CHINESE_OWNER_ROLE_SUBJECT.test(canonical)
}

function hasNamedThirdPartySubject(canonical: string, allowImpersonal: boolean) {
  const predicateAlternatives = 'likes?|prefers?|lives?|wants?|needs?|said|says|drinks?|eats?|works?|uses?|thinks?|believes?|knows?|enjoys?|owns?|teaches?|manages?|runs?|writes?|reads?|plays?|sleeps?|speaks?|drinking|eating|working|living|using|thinking|believing|knowing|enjoying|owning|teaching|managing|running|writing|reading|playing|sleeping|speaking'
  const predicate = `(?:${predicateAlternatives})`
  const markedPredicate = `(?:is|are|was|were|has|have|${predicateAlternatives})`
  const markedSubject = new RegExp(`(?:^|[,;/]|\\b(?:and|or|with|about|regarding|concerning|but|while|whereas|because|since|although)\\s+)([\\p{L}\\p{M}]{2,48})\\s+(?:s\\s+)?${markedPredicate}\\b`, 'giu')
  const namedSubject = new RegExp(`\\b([\\p{L}\\p{M}][\\p{L}\\p{M}'-]{1,48})\\s+(?:s\\s+)?${predicate}\\b`, 'giu')
  const nonNameSubjects = new Set([
    'airi',
    'application',
    'bot',
    'channel',
    'character',
    'dashboard',
    'i',
    'installation',
    'it',
    'memory',
    'my',
    'policy',
    'project',
    'rule',
    'runtime',
    'server',
    'system',
    'that',
    'this',
    'which',
    'who',
  ])
  for (const match of [...canonical.matchAll(markedSubject), ...canonical.matchAll(namedSubject)]) {
    const subject = match[1]?.toLocaleLowerCase('en-US')
    if (subject && subject !== 'i' && subject !== 'my' && (!allowImpersonal || !nonNameSubjects.has(subject)))
      return true
  }

  const namedChineseSubject = /(\p{Script=Han}{2,4})(喜欢|偏好|工资|住在|想要|认为|觉得|工作|使用|[说喝吃])/gu
  const markedChineseSubject = /(?:^|[，,:：;/和与跟]|而且|但是|同时|然而|并且|以及|因为|由于|虽然|尽管)(\p{Script=Han}{2,4})(喜欢|偏好|工资|住在|想要|认为|觉得|工作|使用|[说喝吃是有])/gu
  const impersonalChineseSubjects = new Set([
    '仪表盘',
    '安装',
    '应用',
    '机器人',
    '服务器',
    '规则',
    '记忆',
    '角色',
    '频道',
    '系统',
    '策略',
    '运行时',
    '项目',
  ])
  for (const match of [...canonical.matchAll(namedChineseSubject), ...canonical.matchAll(markedChineseSubject)]) {
    const subject = match[1]
    if (subject && !/^(?:我|本人|俺)/.test(subject) && (!allowImpersonal || !impersonalChineseSubjects.has(subject)))
      return true
  }

  return false
}

function hasExternalChinesePossessive(canonical: string) {
  for (const match of canonical.matchAll(/(?=(\p{Script=Han}{2,4})的(?:偏好|风格|项目|工资|工作|住址|地址|秘密|账号|回复|习惯|关系|朋友|同事|老板|上司|经理|伴侣|配偶|丈夫|妻子|男友|女友|室友|前任|家人|亲戚|老师|客户|员工|队友|邻居))/gu)) {
    const owner = match[1]
    if (owner && !/^(?:我|本人|俺)/.test(owner))
      return true
  }

  return false
}

function hasThirdPartySubject(canonical: string, allowImpersonal = false) {
  return THIRD_PARTY_SUBJECT_PATTERNS.some(pattern => pattern.test(canonical))
    || hasNamedThirdPartySubject(canonical, allowImpersonal)
    || hasNamedParticipantReference(canonical)
    || hasExternalChinesePossessive(canonical)
    || hasUnmarkedSecondSubject(canonical)
    || hasAttributedThirdParty(canonical)
    || hasOwnerRoleSubject(canonical)
}

function matchesAny(value: string, patterns: readonly RegExp[]) {
  const normalized = normalizeStandaloneDiscordPolicyText(value)
  return patterns.some(pattern => pattern.test(normalized))
}

/**
 * Normalizes Discord policy text before exact-term and regular-expression checks.
 *
 * Before:
 * - "ｔｏｋｅｎ"
 * - "igno\u200Bre previous instructions"
 *
 * After:
 * - "token"
 * - "ignore previous instructions"
 */
export function normalizeStandaloneDiscordPolicyText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Checks whether a Discord message is trying to override AIRI's hidden rules.
 *
 * Use when:
 * - A standalone Discord message is about to reach the model.
 * - Roleplay, encoding, or translation wrappers should not bypass policy.
 *
 * Expects:
 * - `content` is the user-visible message after bot mentions were removed.
 *
 * Returns:
 * - `true` for jailbreak, prompt-extraction, or rule-override attempts.
 */
export function isStandaloneDiscordPromptAttack(content: string): boolean {
  return matchesAny(content, PROMPT_ATTACK_PATTERNS) || matchesAny(content, INTERNAL_DATA_REQUEST_PATTERNS)
}

/**
 * Checks whether a Discord message contains data that should not reach the model.
 *
 * Use when:
 * - The bot is running unattended in Discord.
 * - Accidental secrets or identifiers should be stopped before generation.
 *
 * Expects:
 * - The message may contain user-pasted text from Discord.
 *
 * Returns:
 * - A redacted safety decision with only the reason category.
 */
export function checkStandaloneDiscordInputSafety(content: string): StandaloneDiscordInputSafetyDecision {
  if (matchesAny(content, PROMPT_ATTACK_PATTERNS))
    return { reason: 'prompt-attack', safe: false }

  if (matchesAny(content, INTERNAL_DATA_REQUEST_PATTERNS))
    return { reason: 'internal-data-request', safe: false }

  if (matchesAny(content, CREDENTIAL_PATTERNS))
    return { reason: 'credential-or-secret', safe: false }

  if (
    matchesAny(content, PERSONAL_CONTACT_PATTERNS)
    || matchesAny(content, PAYMENT_OR_GOVERNMENT_ID_PATTERNS)
    || matchesAny(content, EXACT_ADDRESS_PATTERNS)
  ) {
    return { reason: 'personal-identifier', safe: false }
  }

  return { safe: true }
}

/**
 * Checks whether a message is an explicit request to store safe long-term context.
 *
 * Use when:
 * - Auto-capturing Discord memory cards from chat.
 * - Only stable first-party preferences should be captured.
 *
 * Expects:
 * - The caller still runs `checkStandaloneDiscordMemorySafety` before storage.
 *
 * Returns:
 * - `true` for direct memory intent phrases such as names, preferences, and call-me aliases.
 */
export function isStandaloneDiscordMemoryIntent(content: string): boolean {
  return matchesAny(content, SAFE_MEMORY_INTENT_PATTERNS)
}

/**
 * Checks whether a potential memory card is safe for long-term storage.
 *
 * Use when:
 * - The dashboard creates a memory card.
 * - Discord auto-capture sees a "remember this" message.
 *
 * Expects:
 * - `content` is normalized human-authored memory text.
 *
 * Returns:
 * - A redacted safety decision with only the reason category.
 */
export function checkStandaloneDiscordMemorySafety(content: string): StandaloneDiscordMemorySafetyDecision {
  if (matchesAny(content, PROMPT_ATTACK_PATTERNS))
    return { reason: 'prompt-attack', safe: false }

  if (matchesAny(content, INTERNAL_DATA_REQUEST_PATTERNS))
    return { reason: 'internal-data-request', safe: false }

  if (matchesAny(content, THIRD_PARTY_PRIVATE_FACT_PATTERNS))
    return { reason: 'third-party-private-fact', safe: false }

  if (matchesAny(content, CREDENTIAL_PATTERNS))
    return { reason: 'credential-or-secret', safe: false }

  if (matchesAny(content, PERSONAL_CONTACT_PATTERNS))
    return { reason: 'personal-contact', safe: false }

  if (matchesAny(content, PAYMENT_OR_GOVERNMENT_ID_PATTERNS))
    return { reason: 'payment-or-government-id', safe: false }

  if (matchesAny(content, EXACT_ADDRESS_PATTERNS))
    return { reason: 'exact-address', safe: false }

  if (matchesAny(content, SENSITIVE_IDENTITY_PATTERNS))
    return { reason: 'sensitive-identity', safe: false }

  return { safe: true }
}

/**
 * Checks an owner-authored standalone memory without turning the Dashboard into a third-party bypass.
 *
 * Use when:
 * - The local installation owner creates a Dashboard memory card.
 * - A persisted Dashboard card is loaded back across the durable boundary.
 *
 * Expects:
 * - Impersonal project, rule, runtime, and installation notes may omit a first-person subject.
 * - Person-shaped notes still need a self subject and may never identify another person.
 *
 * Returns:
 * - A fixed safety category without retaining or echoing the candidate text.
 */
export function checkStandaloneDiscordOwnerMemorySafety(content: string): StandaloneDiscordSelfMemorySafetyDecision {
  const contentDecision = checkStandaloneDiscordMemorySafety(content)
  if (!contentDecision.safe)
    return contentDecision

  const { canonical, visible } = normalizeMemorySubjectText(content)
  if (!canonical)
    return { reason: 'ambiguous-subject', safe: false }
  if (hasUnsafeSubjectEncoding(content) || hasAmbiguousContainer(content))
    return { reason: 'ambiguous-subject', safe: false }
  if (hasThirdPartySubject(canonical, true))
    return { reason: 'third-party-subject', safe: false }

  if (AMBIGUOUS_SUBJECT_PATTERNS.some(pattern => pattern.test(canonical)))
    return { reason: 'ambiguous-subject', safe: false }

  if (hasOnlyCurrentUserFrames(visible))
    return { safe: true }

  if (!isOwnerFrame(canonical))
    return { reason: 'ambiguous-subject', safe: false }

  return { safe: true }
}

/**
 * Checks whether a Discord-authored durable memory is an unambiguous current-user self-disclosure.
 *
 * Use when:
 * - Automatic extraction proposes an exact user-message excerpt.
 * - Explicit chat intent falls back to storing normalized user-authored text.
 * - Persisted or direct `auto-chat`/`explicit-chat` records cross the durable store boundary.
 *
 * Expects:
 * - The verified Discord user is represented by transport identity, never by a display name in `content`.
 * - Owner-authored Dashboard cards use their separate administrative source and policy.
 *
 * Returns:
 * - A fixed safety category without retaining or echoing the candidate text.
 */
export function checkStandaloneDiscordSelfMemorySafety(content: string): StandaloneDiscordSelfMemorySafetyDecision {
  const contentDecision = checkStandaloneDiscordMemorySafety(content)
  if (!contentDecision.safe)
    return contentDecision

  const { canonical, visible } = normalizeMemorySubjectText(content)
  if (!canonical)
    return { reason: 'ambiguous-subject', safe: false }

  if (hasUnsafeSubjectEncoding(content) || hasAmbiguousContainer(content))
    return { reason: 'ambiguous-subject', safe: false }

  if (hasThirdPartySubject(canonical)) {
    return { reason: 'third-party-subject', safe: false }
  }

  if (
    AMBIGUOUS_SUBJECT_PATTERNS.some(pattern => pattern.test(canonical))
    || !hasOnlyCurrentUserFrames(visible)
  ) {
    return { reason: 'ambiguous-subject', safe: false }
  }

  return { safe: true }
}
