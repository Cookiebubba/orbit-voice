// SP3-inspired smart routing, advisory topic-drift detection, and per-session prompt queue
// (Swift port of src/router/{ranker.js, drift.js, queue.js}).
import Foundation
import OrbitIntent
import OrbitKit

// MARK: - Types

public struct SessionContext: Sendable, Equatable {
  public var id: String
  public var title: String
  public var project: String
  public var cwd: String
  public var branch: String?
  public var status: String
  public var waiting: Bool
  public var working: Bool
  public var lastActivityAt: Double
  public var lastFocusedAt: Double
  public var recentFiles: [String]
  public var lastMessages: [String]
  public var recentCommits: [String]

  public init(
    id: String,
    title: String = "(untitled)",
    project: String = "",
    cwd: String = "",
    branch: String? = nil,
    status: String = "idle",
    waiting: Bool = false,
    working: Bool = false,
    lastActivityAt: Double = 0,
    lastFocusedAt: Double = 0,
    recentFiles: [String] = [],
    lastMessages: [String] = [],
    recentCommits: [String] = []
  ) {
    self.id = id
    self.title = title
    self.project = project
    self.cwd = cwd
    self.branch = branch
    self.status = status
    self.waiting = waiting
    self.working = working
    self.lastActivityAt = lastActivityAt
    self.lastFocusedAt = lastFocusedAt
    self.recentFiles = recentFiles
    self.lastMessages = lastMessages
    self.recentCommits = recentCommits
  }

  /** JSON representation matching `harvestSessionContext` in `src/router/context.js`. */
  public var json: JSONValue {
    [
      "id": .string(id),
      "title": .string(title),
      "project": .string(project),
      "cwd": .string(cwd),
      "branch": branch.map { .string($0) } ?? .null,
      "status": .string(status),
      "waiting": .bool(waiting),
      "lastActivityAt": .number(lastActivityAt),
      "lastFocusedAt": .number(lastFocusedAt),
      "recentFiles": .array(recentFiles.map { .string($0) }),
      "lastMessages": .array(lastMessages.map { .string($0) }),
      "recentCommits": .array(recentCommits.map { .string($0) }),
    ]
  }
}

public struct RouterWeights: Sendable, Equatable {
  public var titleMatch: Double
  public var projectMatch: Double
  public var fileMatch: Double
  public var messageOverlap: Double
  public var typed0: Double
  public var typed1: Double
  public var typed2: Double
  public var typedAgeDecay: Double
  public var spokeRecent: Double
  public var waitingBonus: Double
  public var noneBias: Double
  public var noneNewish: Double
  public var noneWords: Double

  public static let defaults = RouterWeights(
    titleMatch: 3.2,
    projectMatch: 2.8,
    fileMatch: 3.6,
    messageOverlap: 2.2,
    typed0: 1.4,
    typed1: 0.7,
    typed2: 0.35,
    typedAgeDecay: 0.03,
    spokeRecent: 1.6,
    waitingBonus: 1.15,
    noneBias: 0.85,
    noneNewish: 2.5,
    noneWords: 0.06
  )

  public init(
    titleMatch: Double = 3.2,
    projectMatch: Double = 2.8,
    fileMatch: Double = 3.6,
    messageOverlap: Double = 2.2,
    typed0: Double = 1.4,
    typed1: Double = 0.7,
    typed2: Double = 0.35,
    typedAgeDecay: Double = 0.03,
    spokeRecent: Double = 1.6,
    waitingBonus: Double = 1.15,
    noneBias: Double = 0.85,
    noneNewish: Double = 2.5,
    noneWords: Double = 0.06
  ) {
    self.titleMatch = titleMatch
    self.projectMatch = projectMatch
    self.fileMatch = fileMatch
    self.messageOverlap = messageOverlap
    self.typed0 = typed0
    self.typed1 = typed1
    self.typed2 = typed2
    self.typedAgeDecay = typedAgeDecay
    self.spokeRecent = spokeRecent
    self.waitingBonus = waitingBonus
    self.noneBias = noneBias
    self.noneNewish = noneNewish
    self.noneWords = noneWords
  }
}

public struct RankedCandidate: Sendable, Equatable {
  public let id: String
  public let isNone: Bool
  public let context: SessionContext?
  public let score: Double
  public let probability: Double
  public let breakdown: [String: Double]
  public let reasons: [String]
}

public struct RankResult: Sendable, Equatable {
  public let best: SessionContext?
  public let score: Double
  public let runnerUp: SessionContext?
  public let margin: Double
  public let confidence: Double
  public let ambiguous: Bool
  public let suggestNew: Bool
  public let candidates: [RankedCandidate]
  public let reasons: [String]
}

public struct DriftResult: Sendable, Equatable {
  public let drifted: Bool
  public let confidence: Double
  public let reason: String?
  public let suggestedSession: SessionContext?
  public let suggestNew: Bool
  public let warning: String?
}

// MARK: - Ranker & Drift Guard

public enum SessionRouter {
  public static let defaultDriftThreshold = 0.8
  private static let longPromptWords = 25

  private static let stopwords: Set<String> = [
    "a", "an", "and", "any", "are", "as", "at", "be", "been", "being", "but", "by",
    "can", "could", "did", "do", "does", "for", "from", "get", "got", "had", "has",
    "have", "hey", "hi", "here", "how", "i", "if", "in", "into", "is", "it", "its",
    "just", "let", "lets", "make", "me", "my", "need", "now", "of", "ok", "okay",
    "on", "or", "our", "out", "please", "should", "so", "some", "still", "that",
    "the", "their", "them", "then", "there", "these", "they", "this", "those", "to",
    "up", "us", "want", "was", "we", "were", "what", "when", "where", "which", "who",
    "why", "will", "with", "would", "you", "your",
    "claude", "orbit", "session", "thread", "tell", "ask", "switch", "open", "check",
  ]

  private static let codeExtensions: Set<String> = [
    "js", "mjs", "cjs", "jsx", "ts", "tsx", "mts", "cts",
    "py", "rb", "go", "rs", "java", "kt", "swift", "c", "cc", "cpp", "h", "hpp", "cs", "php",
    "json", "jsonc", "yaml", "yml", "toml", "ini", "env", "xml", "csv", "sql", "graphql", "gql", "prisma",
    "md", "mdx", "txt", "html", "htm", "css", "scss", "sass", "less", "svg", "vue", "svelte", "astro",
    "sh", "bash", "zsh", "ps1", "bat", "cmd", "lock", "proto", "tf",
  ]

  private static let specialFiles: Set<String> = [
    "dockerfile", "makefile", "gemfile", "rakefile", "procfile", "jenkinsfile",
    "cmakelists.txt", "package.json", "tsconfig.json", "cargo.toml", "go.mod", "go.sum", "pyproject.toml",
  ]

  private static let runtimeNames: Set<String> = [
    "node.js", "next.js", "nuxt.js", "vue.js", "react.js", "three.js", "express.js", "nest.js", "bun.js", "deno.js",
  ]

  private static let genericStems: Set<String> = [
    "index", "utils", "helper", "helpers", "types", "config", "server", "client", "tests",
    "styles", "readme", "manager", "service", "handler", "controller", "store", "model", "module",
  ]

  private static let commitNoiseTokens: Set<String> = [
    "feat", "fix", "chore", "refactor", "style", "docs", "ci", "perf", "add", "update", "remove", "change", "also",
  ]

  private static let branchNoiseTokens: Set<String> = [
    "feat", "fix", "chore", "main", "master", "dev", "branch",
  ]

  private enum R {
    static let camel1 = try! NSRegularExpression(pattern: "([a-z0-9])([A-Z])")
    static let camel2 = try! NSRegularExpression(pattern: "([A-Z]+)([A-Z][a-z])")
    static let token = try! NSRegularExpression(pattern: "[a-z0-9]+")
    static let nonAlnum = try! NSRegularExpression(pattern: "[^a-z0-9]+")
    static let url = try! NSRegularExpression(pattern: #"\b[a-z][a-z0-9+.-]*://\S+"#, options: .caseInsensitive)
    static let slashPath = try! NSRegularExpression(pattern: #"(?:^|[\s'"`(\[{])((?:\.{1,2}[\\/])?(?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+(?::\d+(?::\d+)?)?)"#)
    static let standaloneFile = try! NSRegularExpression(pattern: #"(?:^|[\s'"`(\[{])((?:\.?[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)\.([A-Za-z0-9]{1,10}))(?=$|[\s'"`)\]}>.,;:!?])"#)
    static let specialFile = try! NSRegularExpression(pattern: #"\b(Dockerfile|Makefile|Gemfile|Rakefile|Procfile|Jenkinsfile)\b"#)
    static let spokenFile = try! NSRegularExpression(pattern: #"\b([A-Za-z][A-Za-z0-9_-]{1,40})\s+dot\s+([A-Za-z0-9]{2,8})\b"#, options: .caseInsensitive)
    static let leadingWrap = try! NSRegularExpression(pattern: #"^['"`(\[{<]+"#)
    static let trailingWrap = try! NSRegularExpression(pattern: #"['"`)\]}>.,;!?]+$"#)
    static let lineSuffix = try! NSRegularExpression(pattern: #":\d+(?::\d+)?$"#)
    static let version = JSRegExp(#"^v?\d+(?:\.\d+)+$"#, "i")
    static let baseValid = JSRegExp(#"^[a-z0-9._-]{2,}$"#)
    static let mimePrefix = JSRegExp(#"^(text|application|image|audio|video)/"#, "i")
    static let codeDirPrefix = JSRegExp(#"^(src|lib|app|apps|packages|pkg|test|tests|spec|scripts|docs|config|ui|web|api|server|client|components|routes|router|pages|public|assets)/"#, "i")
    static let foreignRepo = JSRegExp(#"\b(?:in|for|on)\s+(?:the\s+)?[a-z0-9_-]{3,40}\s+(?:repo|repository|project|codebase|service|app)\b"#, "i")

    static let newWork: [JSRegExp] = [
      JSRegExp(#"\b(?:start|begin|open|create|spin up|kick off|launch|make)\s+(?:a\s+)?(?:brand\s+)?(?:new|fresh|separate)\s+(?:session|thread|task|project|repo|repository|app|application|service|tool|cli|script|package|site|website|dashboard|feature|topic|conversation|workspace)\b"#, "i"),
      JSRegExp(#"\b(?:new|fresh|separate)\s+(?:session|thread|project|topic|conversation|workspace)\b"#, "i"),
      JSRegExp(#"\b(?:from scratch|start fresh|start over|brand new (?:project|app|service|tool|cli|repo|feature|site)|completely different|something (?:completely )?(?:new|different|unrelated)|unrelated (?:task|question|topic|project|work)|different (?:topic|project|task)|switch gears|off topic|on (?:a |an )?(?:separate|different|unrelated|another) note)\b"#, "i"),
      JSRegExp(#"\b(?:scaffold|bootstrap|initialize|init)\s+(?:a\s+)?(?:new\s+)?(?:project|app|application|service|repo|repository|cli|package|site|website|server|api|dashboard)\b"#, "i"),
      JSRegExp(#"\b(?:let'?s|i want to|can we|please)\s+build\s+a\s+(?:new\s+|brand new\s+)?[a-z0-9_-]+(?:\s+[a-z0-9_-]+){0,4}\s+(?:app|application|cli|tool|service|bot|dashboard|website|site|tracker|scraper|extension|server|project)\b"#, "i"),
    ]

    static let bareFollowUp: [JSRegExp] = [
      JSRegExp(#"^(?:yes|yeah|yep|yup|no|nope|nah|ok|okay|sure|alright|right|correct|exactly|agreed|confirmed|affirmative|negative)[!.?]*$"#, "i"),
      JSRegExp(#"^(?:ok(?:ay)?|yeah|yes|sure|alright)?[,\s]*(?:go ahead|do it|do that|proceed|continue|keep going|carry on|run it|run that|try again|retry|retry it|ship it|send it|commit it|commit that|push it|push that|revert it|revert that|undo it|undo that|fix it|fix that|looks good|sounds good|lgtm|approve(?: it)?|allow(?: it| once| always)?|deny(?: it)?|reject(?: it)?|skip(?: it)?|cancel(?: it| that)?|never ?mind|stop|wait|hold on)[!.?]*$"#, "i"),
      JSRegExp(#"^(?:go with |pick |choose |use |select )?(?:option\s+(?:one|two|three|four|five|\d+)|(?:the\s+)?(?:first|second|third|fourth|last)\s+one)[!.?]*$"#, "i"),
      JSRegExp(#"^(?:why|how come|what happened|what did (?:it|that|claude) say|did (?:it|that) (?:work|pass|fail)|any errors|is it (?:done|ready|passing|working)|show me|tell me more|explain (?:it|that)|more details|what'?s next|same(?: thing)?|do the same|one more thing)[!.?]*$"#, "i"),
      JSRegExp(#"^(?:now|also|and|and also|then|next)[,\s]+(?:run|check|fix|add|update|push|commit|test|build|lint|format|rerun|try)\b"#, "i"),
      JSRegExp(#"^(?:run|rerun|check)\s+(?:the\s+)?(?:tests?|build|lint(?:er)?|logs?|status|diff)[!.?]*$"#, "i"),
    ]
  }

  private static func safeText(_ text: String?, maxLen: Int = 8000) -> String {
    guard let text else { return "" }
    return String(text.prefix(maxLen)).trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private static func replaceRegex(_ re: NSRegularExpression, in s: String, with template: String) -> String {
    re.stringByReplacingMatches(in: s, range: NSRange(location: 0, length: (s as NSString).length), withTemplate: template)
  }

  private static func normalizePhrase(_ text: String?) -> String {
    let lower = safeText(text).lowercased()
    return replaceRegex(R.nonAlnum, in: lower, with: " ").trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private static func basenameOf(_ path: String) -> String {
    var clean = path.replacingOccurrences(of: "\\", with: "/")
    while clean.hasSuffix("/") { clean.removeLast() }
    if let idx = clean.lastIndex(of: "/") {
      return String(clean[clean.index(after: idx)...])
    }
    return clean
  }

  private static func stemOf(_ path: String) -> String {
    let base = basenameOf(path)
    if let dot = base.lastIndex(of: "."), dot > base.startIndex {
      return String(base[..<dot])
    }
    return base
  }

  private static func round4(_ v: Double) -> Double {
    (v * 10_000).rounded() / 10_000
  }

  private static func clamp01(_ v: Double) -> Double {
    v.isFinite ? max(0, min(1, v)) : 0
  }

  private static func words(_ s: String) -> [String] {
    s.components(separatedBy: .whitespacesAndNewlines).filter { !$0.isEmpty }
  }

  /** Splits camelCase, snake_case, kebab-case, and paths into lowercase tokens. */
  public static func tokenize(_ text: String, keepStopwords: Bool = false) -> [String] {
    var s = safeText(text)
    s = replaceRegex(R.camel1, in: s, with: "$1 $2")
    s = replaceRegex(R.camel2, in: s, with: "$1 $2")
    s = s.lowercased()
    let ns = s as NSString
    let matches = R.token.matches(in: s, range: NSRange(location: 0, length: ns.length))
    var out: [String] = []
    for m in matches {
      let tok = ns.substring(with: m.range)
      if tok.count < 2 && !(tok.count == 1 && tok.first!.isNumber) { continue }
      if !keepStopwords && stopwords.contains(tok) { continue }
      out.append(tok)
    }
    return out
  }

  /** Extracts mentioned file paths and filenames from a spoken or typed query. */
  public static func extractMentionedFiles(_ text: String) -> [String] {
    let s = safeText(text)
    if s.isEmpty { return [] }
    let withoutUrls = replaceRegex(R.url, in: s, with: " ")
    let ns = withoutUrls as NSString
    let fullRange = NSRange(location: 0, length: ns.length)

    var found: [String] = []
    var seen = Set<String>()

    func add(_ candidate: String) {
      var clean = replaceRegex(R.leadingWrap, in: candidate, with: "")
      clean = replaceRegex(R.trailingWrap, in: clean, with: "")
      clean = replaceRegex(R.lineSuffix, in: clean, with: "")
      clean = clean.replacingOccurrences(of: "\\", with: "/")
      if clean.hasPrefix("./") { clean = String(clean.dropFirst(2)) }
      guard !clean.isEmpty, clean.count <= 260 else { return }
      let lower = clean.lowercased()
      if runtimeNames.contains(lower) || !seen.insert(lower).inserted { return }
      found.append(clean)
    }

    // 1. Explicit slash paths
    for m in R.slashPath.matches(in: withoutUrls, range: fullRange) {
      var cand = ns.substring(with: m.range(at: 1))
      cand = replaceRegex(R.trailingWrap, in: cand, with: "")
      let base = basenameOf(cand).lowercased()
      let ext: String
      if let dot = base.lastIndex(of: "."), dot > base.startIndex {
        ext = String(base[base.index(after: dot)...])
      } else {
        ext = ""
      }
      if !ext.isEmpty && codeExtensions.contains(ext) {
        add(cand)
      } else if specialFiles.contains(base) || base.hasPrefix(".env") {
        add(cand)
      } else if R.baseValid.test(base) && !R.mimePrefix.test(cand) {
        var normCand = cand.replacingOccurrences(of: "\\", with: "/")
        if normCand.hasPrefix("./") { normCand = String(normCand.dropFirst(2)) }
        if R.codeDirPrefix.test(normCand) { add(cand) }
      }
    }

    // 2. Standalone filenames with known extensions
    for m in R.standaloneFile.matches(in: withoutUrls, range: fullRange) {
      let full = ns.substring(with: m.range(at: 1))
      let ext = ns.substring(with: m.range(at: 2)).lowercased()
      if R.version.test(full) { continue }
      if full.lowercased().hasPrefix(".env") {
        add(full)
        continue
      }
      if codeExtensions.contains(ext) {
        add(full)
      }
    }

    // 3. Special extensionless filenames
    for m in R.specialFile.matches(in: withoutUrls, range: fullRange) {
      add(ns.substring(with: m.range(at: 1)))
    }

    // 4. Spoken file names like "server dot js"
    for m in R.spokenFile.matches(in: withoutUrls, range: fullRange) {
      let stem = ns.substring(with: m.range(at: 1)).lowercased()
      let ext = ns.substring(with: m.range(at: 2)).lowercased()
      if codeExtensions.contains(ext) {
        add("\(stem).\(ext)")
      }
    }

    return found
  }

  /** Returns true if the utterance strongly signals brand-new, separate work. */
  public static func looksLikeNewWork(_ text: String) -> Bool {
    let s = safeText(text)
    if s.isEmpty { return false }
    return R.newWork.contains { $0.test(s) }
  }

  /** Returns true if the utterance is a short, context-dependent follow-up. */
  public static func isBareFollowUp(_ text: String) -> Bool {
    let s = safeText(text)
    if s.isEmpty { return false }
    let ws = words(s)
    if ws.isEmpty || ws.count > 10 { return false }
    if looksLikeNewWork(s) { return false }
    if !extractMentionedFiles(s).isEmpty { return false }
    return R.bareFollowUp.contains { $0.test(s) }
  }

  private static func tokenMatch(_ a: String, _ b: String) -> Double {
    if a == b { return 1 }
    if a.count >= 4 && b.count >= 4 {
      let shorter = a.count <= b.count ? a : b
      let longer = a.count <= b.count ? b : a
      if longer.hasPrefix(shorter) && Double(shorter.count) / Double(longer.count) >= 0.6 {
        return 0.75
      }
    }
    return 0
  }

  private static func tokenOverlapScore(_ queryTokens: [String], _ targetTokens: [String]) -> Double {
    guard !queryTokens.isEmpty && !targetTokens.isEmpty else { return 0 }
    var queryHits = 0.0
    for qt in queryTokens {
      var best = 0.0
      for tt in targetTokens {
        let m = tokenMatch(qt, tt)
        if m > best { best = m }
        if best == 1 { break }
      }
      queryHits += best
    }
    var targetHits = 0.0
    for tt in targetTokens {
      var best = 0.0
      for qt in queryTokens {
        let m = tokenMatch(tt, qt)
        if m > best { best = m }
        if best == 1 { break }
      }
      targetHits += best
    }
    let qRecall = queryHits / Double(queryTokens.count)
    let tRecall = targetHits / Double(targetTokens.count)
    return min(1, 0.55 * tRecall + 0.45 * qRecall)
  }

  private static func scoreTitleMatch(_ queryPhrase: String, _ queryTokens: [String], _ ctx: SessionContext) -> Double {
    let rawTitle = safeText(ctx.title)
    if rawTitle.isEmpty || rawTitle == "(untitled)" { return 0 }
    let titlePhrase = normalizePhrase(rawTitle)
    if titlePhrase.isEmpty { return 0 }
    if titlePhrase.count >= 3 && queryPhrase.contains(titlePhrase) { return 1 }
    let titleTokens = tokenize(rawTitle)
    var score = tokenOverlapScore(queryTokens, titleTokens)
    if let branch = ctx.branch, !branch.isEmpty {
      let branchTokens = tokenize(branch).filter { !branchNoiseTokens.contains($0) }
      if !branchTokens.isEmpty {
        let bScore = tokenOverlapScore(queryTokens, branchTokens) * 0.85
        if bScore > score { score = bScore }
      }
    }
    return min(1, score)
  }

  private static func scoreProjectMatch(_ queryPhrase: String, _ queryTokens: [String], _ ctx: SessionContext) -> Double {
    let rawProject = safeText(ctx.project)
    if rawProject.isEmpty || rawProject == "(no folder)" { return 0 }
    let projPhrase = normalizePhrase(rawProject)
    if projPhrase.count < 2 { return 0 }
    if " \(queryPhrase) ".contains(" \(projPhrase) ") { return 1 }
    let compactProj = projPhrase.replacingOccurrences(of: " ", with: "")
    let compactQuery = queryPhrase.replacingOccurrences(of: " ", with: "")
    if compactProj.count >= 4 && compactQuery.contains(compactProj) { return 0.95 }
    let projTokens = tokenize(rawProject)
    guard !projTokens.isEmpty else { return 0 }
    var matched = 0.0
    for pt in projTokens {
      var best = 0.0
      for qt in queryTokens {
        let m = tokenMatch(pt, qt)
        if m > best { best = m }
      }
      matched += best
    }
    let ratio = matched / Double(projTokens.count)
    return ratio >= 0.5 ? min(1, ratio * 0.9) : 0
  }

  private static func scoreFileMatch(_ mentionedFiles: [String], _ queryTokens: [String], _ ctx: SessionContext) -> Double {
    let recentFiles = ctx.recentFiles.filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    guard !recentFiles.isEmpty else { return 0 }

    let normRecent = recentFiles.map { f -> (norm: String, base: String, stem: String) in
      var norm = f.replacingOccurrences(of: "\\", with: "/").lowercased()
      if norm.hasPrefix("./") { norm = String(norm.dropFirst(2)) }
      return (norm, basenameOf(norm), stemOf(norm))
    }

    if !mentionedFiles.isEmpty {
      var bestScore = 0.0
      var totalScore = 0.0
      for mf in mentionedFiles {
        var mNorm = mf.replacingOccurrences(of: "\\", with: "/").lowercased()
        if mNorm.hasPrefix("./") { mNorm = String(mNorm.dropFirst(2)) }
        let mBase = basenameOf(mNorm)
        let mStem = stemOf(mNorm)
        var fileBest = 0.0
        for rf in normRecent {
          if rf.norm == mNorm || rf.norm.hasSuffix("/\(mNorm)") || mNorm.hasSuffix("/\(rf.norm)") {
            fileBest = max(fileBest, 1.0)
          } else if rf.base == mBase && mBase.count >= 3 {
            fileBest = max(fileBest, 0.92)
          } else if rf.stem == mStem && mStem.count >= 4 {
            fileBest = max(fileBest, 0.65)
          }
        }
        bestScore = max(bestScore, fileBest)
        totalScore += fileBest
      }
      let avg = totalScore / Double(mentionedFiles.count)
      return min(1, 0.7 * bestScore + 0.3 * avg)
    }

    guard !queryTokens.isEmpty else { return 0 }
    var stemScore = 0.0
    for rf in normRecent {
      if rf.stem.count < 5 || genericStems.contains(rf.stem) { continue }
      let stemTokens = tokenize(rf.stem)
      if stemTokens.isEmpty { continue }
      let allPresent = stemTokens.allSatisfy { st in queryTokens.contains { tokenMatch(st, $0) >= 0.75 } }
      if allPresent {
        stemScore = max(stemScore, 0.45)
      } else {
        let distinctiveHit = stemTokens.contains { st in
          st.count >= 6 && !genericStems.contains(st) && queryTokens.contains { tokenMatch(st, $0) >= 0.85 }
        }
        if distinctiveHit { stemScore = max(stemScore, 0.3) }
      }
    }
    return stemScore
  }

  private static func tokenSpecificity(_ tok: String) -> Double {
    if commitNoiseTokens.contains(tok) { return 0.25 }
    if tok.count >= 7 { return 1.4 }
    if tok.count >= 5 { return 1.15 }
    return 0.75
  }

  private static func scoreMessageOverlap(_ queryTokens: [String], _ ctx: SessionContext) -> Double {
    guard !queryTokens.isEmpty else { return 0 }
    var sources: [String] = []
    for m in ctx.lastMessages where !m.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { sources.append(m) }
    for c in ctx.recentCommits where !c.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { sources.append(c) }
    guard !sources.isEmpty else { return 0 }

    var targetSet = Set<String>()
    for src in sources {
      for tok in tokenize(src) { targetSet.insert(tok) }
    }
    guard !targetSet.isEmpty else { return 0 }

    let targetArr = Array(targetSet)
    var weightedHits = 0.0
    var totalWeight = 0.0
    for qt in queryTokens {
      let w = tokenSpecificity(qt)
      totalWeight += w
      var best = 0.0
      for tt in targetArr {
        let m = tokenMatch(qt, tt)
        if m > best { best = m }
        if best == 1 { break }
      }
      weightedHits += best * w
    }
    let recall = totalWeight > 0 ? weightedHits / totalWeight : 0
    let absFactor = min(1, weightedHits / 3)
    return min(1, 0.65 * recall + 0.35 * absFactor)
  }

  private static func computeRecencyRanks(
    _ contexts: [SessionContext],
    activeId: String?,
    recentInteractedIds: [String]?
  ) -> [String: Int] {
    var ranks: [String: Int] = [:]
    if let recent = recentInteractedIds, !recent.isEmpty {
      var ordered: [String] = []
      var seen = Set<String>()
      func push(_ id: String) {
        guard !id.isEmpty, seen.insert(id).inserted else { return }
        ordered.append(id)
      }
      if let activeId, !activeId.isEmpty, !recent.contains(activeId) { push(activeId) }
      for id in recent { push(id) }
      for (i, id) in ordered.enumerated() { ranks[id] = i }
      return ranks
    }

    var nextRank = 0
    if let activeId, !activeId.isEmpty {
      ranks[activeId] = 0
      nextRank = 1
    }

    let remaining = contexts
      .filter { !$0.id.isEmpty && ranks[$0.id] == nil }
      .map { (id: $0.id, ts: max($0.lastFocusedAt, $0.lastActivityAt)) }
      .sorted { $0.ts > $1.ts }

    var prevTs: Double? = nil
    var currentRank = nextRank
    for (i, item) in remaining.enumerated() {
      if let prev = prevTs, item.ts < prev {
        currentRank = nextRank + i
      }
      ranks[item.id] = currentRank
      prevTs = item.ts
    }
    return ranks
  }

  /** Ranks session contexts + a synthetic `none` (new session) option for a spoken/typed query. */
  public static func rankCandidates(
    query: String,
    contexts: [SessionContext],
    activeId: String? = nil,
    lastSpokenId: String? = nil,
    lastSpokenAt: Double = 0,
    recentInteractedIds: [String]? = nil,
    now: Double = Date().timeIntervalSince1970 * 1000,
    weights: RouterWeights = .defaults
  ) -> RankResult {
    let q = safeText(query)
    let w = weights
    let nowMs = now.isFinite ? now : Date().timeIntervalSince1970 * 1000

    if q.isEmpty {
      let active = activeId.flatMap { aid in contexts.first { $0.id == aid } }
      return RankResult(
        best: active,
        score: 0,
        runnerUp: nil,
        margin: 0,
        confidence: active != nil ? 1 : 0,
        ambiguous: false,
        suggestNew: active == nil && contexts.isEmpty,
        candidates: [],
        reasons: ["emptyQuery"]
      )
    }

    let queryPhrase = normalizePhrase(q)
    let queryTokens = tokenize(q)
    let mentionedFiles = extractMentionedFiles(q)
    let bareFollowUp = isBareFollowUp(q)
    let newWork = looksLikeNewWork(q)
    let wordCount = words(q).count

    let recencyRanks = computeRecencyRanks(contexts, activeId: activeId, recentInteractedIds: recentInteractedIds)
    let typedWeights = [w.typed0, w.typed1, w.typed2]

    struct RawCandidate {
      let id: String
      let isNone: Bool
      let context: SessionContext?
      let score: Double
      var probability: Double
      let breakdown: [String: Double]
      let reasons: [String]
    }

    var all: [RawCandidate] = contexts.map { ctx in
      let titleS = scoreTitleMatch(queryPhrase, queryTokens, ctx)
      let projectS = scoreProjectMatch(queryPhrase, queryTokens, ctx)
      let fileS = scoreFileMatch(mentionedFiles, queryTokens, ctx)
      let msgS = scoreMessageOverlap(queryTokens, ctx)

      let recIdx = recencyRanks[ctx.id] ?? -1
      let baseTyped = (recIdx >= 0 && recIdx < typedWeights.count) ? typedWeights[recIdx] : 0
      let ts = max(ctx.lastFocusedAt, ctx.lastActivityAt)
      let ageMin = (ts > 0 && nowMs > ts) ? (nowMs - ts) / 60_000 : 0
      let ageDecay = ts > 0 ? exp(-max(0, w.typedAgeDecay) * ageMin) : 1
      let typedContrib = baseTyped * ageDecay

      var spokeContrib = 0.0
      if let lastSpokenId, ctx.id == lastSpokenId {
        let spokeAgeMin = (lastSpokenAt > 0 && nowMs > lastSpokenAt) ? (nowMs - lastSpokenAt) / 60_000 : 0
        let spokeDecay = lastSpokenAt > 0 ? exp(-0.15 * spokeAgeMin) : 1
        spokeContrib = w.spokeRecent * spokeDecay * (bareFollowUp ? 1.25 : 1)
      }

      let isWaiting = ctx.waiting || ctx.status == "waiting"
      let waitingContrib = isWaiting ? w.waitingBonus * (bareFollowUp ? 1.45 : 1) : 0

      let breakdown: [String: Double] = [
        "titleMatch": titleS * w.titleMatch,
        "projectMatch": projectS * w.projectMatch,
        "fileMatch": fileS * w.fileMatch,
        "messageOverlap": msgS * w.messageOverlap,
        "typed": typedContrib,
        "spokeRecent": spokeContrib,
        "waitingBonus": waitingContrib,
      ]

      let score =
        breakdown["titleMatch"]! +
        breakdown["projectMatch"]! +
        breakdown["fileMatch"]! +
        breakdown["messageOverlap"]! +
        breakdown["typed"]! +
        breakdown["spokeRecent"]! +
        breakdown["waitingBonus"]!

      var reasons: [String] = []
      if fileS >= 0.6 { reasons.append("fileMatch") }
      if projectS >= 0.5 { reasons.append("projectMatch") }
      if titleS >= 0.4 { reasons.append("titleMatch") }
      if msgS >= 0.35 { reasons.append("messageOverlap") }
      if ctx.id == activeId { reasons.append("activeSession") }
      else if recIdx >= 0 && recIdx < 3 && typedContrib >= 0.25 { reasons.append("recentSession_\(recIdx)") }
      if spokeContrib >= 0.4 { reasons.append("recentlySpoken") }
      if waitingContrib > 0 { reasons.append("waitingForInput") }
      if bareFollowUp && score > 0 { reasons.append("bareFollowUp") }

      return RawCandidate(
        id: ctx.id,
        isNone: false,
        context: ctx,
        score: score,
        probability: 0,
        breakdown: breakdown,
        reasons: reasons
      )
    }

    // Synthetic `none` candidate
    let wordsTerm = bareFollowUp ? 0 : Double(min(wordCount, 25)) * w.noneWords
    let newishTerm = newWork ? w.noneNewish : 0
    let rawNoneScore = w.noneBias + newishTerm + wordsTerm
    let noneScore = (bareFollowUp && !contexts.isEmpty) ? rawNoneScore * 0.25 : rawNoneScore

    var noneReasons: [String] = []
    if newWork { noneReasons.append("newWorkSignal") }
    if wordsTerm >= 0.5 { noneReasons.append("selfContainedPrompt") }
    if contexts.isEmpty { noneReasons.append("noSessions") }
    if noneReasons.isEmpty { noneReasons.append("noneBaseline") }

    all.append(RawCandidate(
      id: "none",
      isNone: true,
      context: nil,
      score: noneScore,
      probability: 0,
      breakdown: [
        "noneBias": (bareFollowUp && !contexts.isEmpty) ? w.noneBias * 0.25 : w.noneBias,
        "noneNewish": newishTerm,
        "noneWords": wordsTerm,
      ],
      reasons: noneReasons
    ))

    // Stable sort descending by score
    all.sort { $0.score > $1.score }

    let maxScore = all[0].score
    var expSum = 0.0
    var exps: [Double] = []
    exps.reserveCapacity(all.count)
    for c in all {
      let e = exp(c.score - maxScore)
      exps.append(e)
      expSum += e
    }
    for i in 0..<all.count {
      all[i].probability = expSum > 0 ? exps[i] / expSum : 0
    }

    let top = all[0]
    let second = all.count > 1 ? all[1] : nil
    let margin = second.map { top.score - $0.score } ?? top.score
    let confidence = round4(top.probability)
    let suggestNew = top.isNone

    let runnerUpCandidate: RawCandidate?
    if let second, !second.isNone {
      runnerUpCandidate = second
    } else {
      runnerUpCandidate = all.dropFirst().first { !$0.isNone }
    }

    let ambiguous: Bool
    if second != nil {
      if !suggestNew {
        ambiguous = margin < 0.65 || (confidence < 0.52 && margin < 0.85)
      } else {
        ambiguous = !contexts.isEmpty && margin < 0.45
      }
    } else {
      ambiguous = false
    }

    let finalCandidates = all.map {
      RankedCandidate(
        id: $0.id,
        isNone: $0.isNone,
        context: $0.context,
        score: round4($0.score),
        probability: round4($0.probability),
        breakdown: $0.breakdown,
        reasons: $0.reasons
      )
    }

    return RankResult(
      best: top.isNone ? nil : top.context,
      score: round4(top.score),
      runnerUp: runnerUpCandidate?.context,
      margin: round4(margin),
      confidence: confidence,
      ambiguous: ambiguous,
      suggestNew: suggestNew,
      candidates: finalCandidates,
      reasons: top.reasons
    )
  }

  // MARK: - Topic Drift Guard

  private static func overlapRatio(_ queryTokens: [String], _ targetTokens: [String]) -> Double {
    guard !queryTokens.isEmpty && !targetTokens.isEmpty else { return 0 }
    var hits = 0.0
    for qt in queryTokens {
      var best = 0.0
      for tt in targetTokens {
        let m = tokenMatch(qt, tt)
        if m > best { best = m }
        if best == 1 { break }
      }
      hits += best
    }
    return hits / Double(queryTokens.count)
  }

  private static func projectMentioned(_ textPhrase: String, _ textTokens: [String], _ ctx: SessionContext) -> Bool {
    let raw = safeText(ctx.project)
    if raw.isEmpty || raw == "(no folder)" { return false }
    let projPhrase = normalizePhrase(raw)
    if projPhrase.count < 2 { return false }
    if " \(textPhrase) ".contains(" \(projPhrase) ") { return true }
    let compactProj = projPhrase.replacingOccurrences(of: " ", with: "")
    if compactProj.count >= 4 && textPhrase.replacingOccurrences(of: " ", with: "").contains(compactProj) { return true }
    let projTokens = tokenize(raw)
    if projTokens.count >= 2 {
      let hits = projTokens.filter { pt in textTokens.contains { tokenMatch(pt, $0) >= 0.85 } }.count
      if hits == projTokens.count { return true }
    }
    return false
  }

  private static func filesMatchContext(_ mentionedFiles: [String], _ ctx: SessionContext) -> Bool {
    guard !mentionedFiles.isEmpty && !ctx.recentFiles.isEmpty else { return false }
    let recent = ctx.recentFiles
      .filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
      .map { f -> (norm: String, base: String) in
        var norm = f.replacingOccurrences(of: "\\", with: "/").lowercased()
        if norm.hasPrefix("./") { norm = String(norm.dropFirst(2)) }
        return (norm, basenameOf(norm))
      }
    for mf in mentionedFiles {
      var mNorm = mf.replacingOccurrences(of: "\\", with: "/").lowercased()
      if mNorm.hasPrefix("./") { mNorm = String(mNorm.dropFirst(2)) }
      let mBase = basenameOf(mNorm)
      for rf in recent {
        if rf.norm == mNorm || rf.norm.hasSuffix("/\(mNorm)") || mNorm.hasSuffix("/\(rf.norm)") { return true }
        if mBase.count >= 3 && rf.base == mBase { return true }
      }
    }
    return false
  }

  private static func titleMatchStrength(_ textPhrase: String, _ textTokens: [String], _ ctx: SessionContext) -> Double {
    let raw = safeText(ctx.title)
    if raw.isEmpty || raw == "(untitled)" { return 0 }
    let titlePhrase = normalizePhrase(raw)
    if titlePhrase.count >= 4 && textPhrase.contains(titlePhrase) { return 1 }
    let titleTokens = tokenize(raw)
    guard !titleTokens.isEmpty && !textTokens.isEmpty else { return 0 }
    let tHits = titleTokens.filter { tt in textTokens.contains { tokenMatch(tt, $0) >= 0.75 } }.count
    let qHits = textTokens.filter { qt in titleTokens.contains { tokenMatch(qt, $0) >= 0.75 } }.count
    return 0.6 * (Double(tHits) / Double(titleTokens.count)) + 0.4 * (Double(qHits) / Double(textTokens.count))
  }

  private static func contextLexicalOverlap(_ textTokens: [String], _ ctx: SessionContext) -> Double {
    guard !textTokens.isEmpty else { return 0 }
    var bag = Set<String>()
    for field in [ctx.title, ctx.project, ctx.branch ?? ""] {
      for t in tokenize(field) { bag.insert(t) }
    }
    for f in ctx.recentFiles { for t in tokenize(f) { bag.insert(t) } }
    for m in ctx.lastMessages { for t in tokenize(m) { bag.insert(t) } }
    for c in ctx.recentCommits { for t in tokenize(c) { bag.insert(t) } }
    return overlapRatio(textTokens, Array(bag))
  }

  private static func buildWarning(activeContext: SessionContext, suggestedSession: SessionContext?, suggestNew: Bool) -> String {
    let activeTitle = safeText(activeContext.title).isEmpty ? "the current session" : safeText(activeContext.title)
    if let suggested = suggestedSession {
      let targetTitle = safeText(suggested.title).isEmpty ? "another session" : safeText(suggested.title)
      let targetProj = safeText(suggested.project)
      let label = targetProj.isEmpty ? "\"\(targetTitle)\"" : "\"\(targetTitle)\" (\(targetProj))"
      return "This looks like work for \(label) rather than \"\(activeTitle)\"."
    }
    if suggestNew {
      return "This sounds like a new topic unrelated to \"\(activeTitle)\". Consider starting a new session."
    }
    return "This may be off-topic for \"\(activeTitle)\"."
  }

  /**
   * Advisory check for whether `prompt` has drifted away from `activeContext`.
   * Never auto-switches sessions.
   */
  public static func checkTopicDrift(
    prompt: String,
    activeContext: SessionContext?,
    otherContexts: [SessionContext] = [],
    threshold: Double = defaultDriftThreshold,
    extractSubject: (@Sendable (String) async -> String?)? = nil
  ) async -> DriftResult {
    let noDrift = DriftResult(drifted: false, confidence: 0, reason: nil, suggestedSession: nil, suggestNew: false, warning: nil)
    let rawPrompt = safeText(prompt)
    guard !rawPrompt.isEmpty, let activeContext else { return noDrift }
    if isBareFollowUp(rawPrompt) { return noDrift }

    let effThreshold = threshold.isFinite ? clamp01(threshold) : defaultDriftThreshold
    let others = otherContexts.filter { $0.id != activeContext.id }

    let wordCount = words(rawPrompt).count
    var subjectText = rawPrompt
    var usedExtractedSubject = false

    if wordCount >= longPromptWords, let extractSubject {
      if let extracted = await extractSubject(rawPrompt)?.trimmingCharacters(in: .whitespacesAndNewlines), !extracted.isEmpty {
        subjectText = extracted
        usedExtractedSubject = true
      }
    }

    if isBareFollowUp(subjectText) { return noDrift }

    let phrase = normalizePhrase(subjectText)
    let tokens = tokenize(subjectText)
    let mentionedFiles = extractMentionedFiles(subjectText)

    let activeProjectHit = projectMentioned(phrase, tokens, activeContext)
    let activeFileHit = filesMatchContext(mentionedFiles, activeContext)
    let activeTitleStrength = titleMatchStrength(phrase, tokens, activeContext)
    let activeOverlap = contextLexicalOverlap(tokens, activeContext)
    let anchoredToActive = activeProjectHit || activeFileHit || activeTitleStrength >= 0.45 || activeOverlap >= 0.35

    var bestOther: SessionContext? = nil
    var bestOtherConfidence = 0.0
    var bestOtherReason: String? = nil

    let activeProjNorm = normalizePhrase(activeContext.project)

    for other in others {
      let otherProjNorm = normalizePhrase(other.project)
      let distinctProject = !otherProjNorm.isEmpty && otherProjNorm != activeProjNorm
      let otherFileHit = filesMatchContext(mentionedFiles, other)
      let otherProjectHit = distinctProject && projectMentioned(phrase, tokens, other)
      let otherTitleStrength = titleMatchStrength(phrase, tokens, other)
      let otherOverlap = contextLexicalOverlap(tokens, other)

      var conf = 0.0
      var reason: String? = nil

      if otherFileHit && !activeFileHit {
        conf = (otherProjectHit || otherTitleStrength >= 0.4) ? 0.95 : 0.9
        reason = "other_session_file_match"
      } else if otherProjectHit && !activeProjectHit {
        conf = (otherTitleStrength >= 0.4 || otherOverlap >= 0.35) ? 0.94 : 0.88
        reason = "other_project_mention"
      } else if otherTitleStrength >= 0.6 && activeOverlap < 0.15 {
        conf = min(0.92, 0.82 + (otherTitleStrength - 0.6) * 0.25)
        reason = "other_session_topic_match"
      } else if otherOverlap >= 0.55 && activeOverlap == 0 && tokens.count >= 3 {
        conf = 0.82
        reason = "other_session_topic_match"
      }

      if conf > 0 && anchoredToActive {
        conf *= usedExtractedSubject ? 0.45 : 0.35
      }

      if conf > bestOtherConfidence {
        bestOtherConfidence = conf
        bestOther = other
        bestOtherReason = reason
      }
    }

    var confidence = bestOtherConfidence
    var reason = bestOtherReason
    var suggestedSession = bestOther
    var suggestNew = false

    if looksLikeNewWork(subjectText) && !anchoredToActive {
      let newConf = activeOverlap == 0 ? 0.9 : 0.82
      if newConf > confidence {
        confidence = newConf
        reason = "new_work_topic_shift"
        suggestedSession = nil
        suggestNew = true
      }
    }

    if confidence < effThreshold && !anchoredToActive && activeOverlap == 0 {
      if R.foreignRepo.test(subjectText) {
        confidence = max(confidence, 0.84)
        reason = "foreign_project_mention"
        suggestedSession = nil
        suggestNew = true
      } else if !mentionedFiles.isEmpty && !activeContext.recentFiles.isEmpty {
        confidence = max(confidence, 0.55)
        if reason == nil { reason = "untracked_file_mention" }
      } else if tokens.count >= 5 {
        confidence = max(confidence, 0.45)
        if reason == nil { reason = "low_topic_overlap" }
      }
    }

    confidence = round4(clamp01(confidence))
    let drifted = confidence >= effThreshold

    return DriftResult(
      drifted: drifted,
      confidence: confidence,
      reason: drifted ? reason : nil,
      suggestedSession: drifted ? suggestedSession : nil,
      suggestNew: drifted ? suggestNew : false,
      warning: drifted ? buildWarning(activeContext: activeContext, suggestedSession: suggestedSession, suggestNew: suggestNew) : nil
    )
  }

  // MARK: - Context Harvesting (src/router/context.js)

  private static let contextKnownExtensions: Set<String> = [
    "js", "mjs", "cjs", "jsx", "ts", "tsx", "mts", "cts",
    "py", "rb", "go", "rs", "java", "kt", "swift", "c", "cc", "cpp", "h", "hpp", "cs", "php",
    "json", "jsonc", "yaml", "yml", "toml", "ini", "env", "xml", "csv", "sql", "graphql", "gql", "prisma",
    "md", "mdx", "txt", "html", "htm", "css", "scss", "sass", "less", "svg", "vue", "svelte", "astro",
    "sh", "bash", "zsh", "ps1", "bat", "cmd", "dockerfile", "makefile", "lock", "proto", "tf",
  ]

  private static let contextUrlRe = JSRegExp(#"^[a-z][a-z0-9+.-]*://"#, "i")
  private static let contextMimeRe = JSRegExp(#"^(text|application|image|audio|video|font|multipart)/"#, "i")
  private static let contextBaseRe = JSRegExp(#"^[A-Za-z0-9._-]+$"#)
  private static let contextCmdTokRe = try! NSRegularExpression(pattern: #""[^"\n]{1,260}"|'[^'\n]{1,260}'|\S+"#)

  private static func normalizeContextFileCandidate(_ raw: String) -> String? {
    var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !s.isEmpty, s.count <= 300 else { return nil }
    s = replaceRegex(R.leadingWrap, in: s, with: "")
    s = replaceRegex(R.trailingWrap, in: s, with: "")
    s = replaceRegex(R.lineSuffix, in: s, with: "")
    if s.isEmpty || contextUrlRe.test(s) || R.version.test(s) || s.hasPrefix("-") { return nil }
    s = s.replacingOccurrences(of: "\\", with: "/")
    if s.hasPrefix("./") { s = String(s.dropFirst(2)) }
    if s.isEmpty || s == "." || s == ".." || s == "/" { return nil }
    if s.contains("*") || s.contains("?") {
      let cleaned = s.split(separator: "/").filter { seg in
        !seg.isEmpty && !seg.contains(where: { "*?[]{}".contains($0) })
      }.joined(separator: "/")
      if cleaned.isEmpty { return nil }
      s = cleaned
    }
    let base = basenameOf(s)
    if base.isEmpty || base == "." || base == ".." { return nil }
    let lowerBase = base.lowercased()
    let ext: String
    if let dot = lowerBase.lastIndex(of: "."), dot > lowerBase.startIndex {
      ext = String(lowerBase[lowerBase.index(after: dot)...])
    } else {
      ext = ""
    }
    if specialFiles.contains(lowerBase) { return s }
    if !ext.isEmpty && contextKnownExtensions.contains(ext) { return s }
    if lowerBase.hasPrefix(".env") || lowerBase == ".gitignore" || lowerBase == ".npmrc" { return s }
    if s.contains("/") && !s.hasSuffix("/") && contextBaseRe.test(base) && base.count >= 2 {
      if contextMimeRe.test(s) { return nil }
      return s
    }
    return nil
  }

  private static func readTailLines(_ filePath: String, maxBytes: Int = 512 * 1024) -> [String] {
    let clean = filePath.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !clean.isEmpty,
          let attrs = try? FileManager.default.attributesOfItem(atPath: clean),
          let fileType = attrs[.type] as? FileAttributeType, fileType == .typeRegular,
          let sizeNum = attrs[.size] as? NSNumber else {
      return []
    }
    let size = sizeNum.intValue
    guard size > 0, let fh = FileHandle(forReadingAtPath: clean) else { return [] }
    defer { try? fh.close() }
    let readBytes = min(size, maxBytes)
    if readBytes < size {
      try? fh.seek(toOffset: UInt64(size - readBytes))
    }
    let data = fh.readData(ofLength: readBytes)
    var lines = String(decoding: data, as: UTF8.self)
      .replacingOccurrences(of: "\r\n", with: "\n")
      .components(separatedBy: "\n")
    if readBytes < size && !lines.isEmpty { lines.removeFirst() }
    return lines
  }

  private static func extractFilesFromToolInput(_ input: JSONValue?) -> [String] {
    guard case .object(let obj)? = input else { return [] }
    var found: [String] = []
    for key in ["file_path", "path", "target_file", "notebook_path", "pattern"] {
      if let s = obj[key]?.stringValue, let norm = normalizeContextFileCandidate(s) {
        found.append(norm)
      }
    }
    if let cmd = obj["command"]?.stringValue, !cmd.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      let ns = cmd as NSString
      for m in contextCmdTokRe.matches(in: cmd, range: NSRange(location: 0, length: ns.length)) {
        var tok = ns.substring(with: m.range)
        if (tok.hasPrefix("\"") && tok.hasSuffix("\"")) || (tok.hasPrefix("'") && tok.hasSuffix("'")) {
          tok = String(tok.dropFirst().dropLast())
        }
        let candidate: String
        if tok.hasPrefix("-"), let eq = tok.firstIndex(of: "="), eq > tok.startIndex {
          candidate = String(tok[tok.index(after: eq)...])
        } else {
          candidate = tok
        }
        if let norm = normalizeContextFileCandidate(candidate) { found.append(norm) }
      }
    }
    return found
  }

  /** Extracts up to `maxFiles` unique recently touched file paths from a `.jsonl` transcript, newest first. */
  public static func extractRecentFiles(transcriptFile: String, maxFiles: Int = 8, maxBytes: Int = 512 * 1024) -> [String] {
    let limit = max(0, min(64, maxFiles))
    guard limit > 0 else { return [] }
    let lines = readTailLines(transcriptFile, maxBytes: max(1024, min(8 * 1024 * 1024, maxBytes)))
    guard !lines.isEmpty else { return [] }

    var seen = Set<String>()
    var recent: [String] = []
    for line in lines.reversed() {
      if recent.count >= limit { break }
      let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
      if trimmed.isEmpty { continue }
      guard let rec = try? JSONValue.parse(trimmed), case .object = rec, rec["isSidechain"] != .bool(true) else { continue }

      var blocks: [JSONValue] = []
      if rec["type"] == "tool_use" {
        blocks.append(rec)
      } else if let content = rec["message"]?["content"]?.arrayValue {
        for c in content where c["type"] == "tool_use" { blocks.append(c) }
      }
      for block in blocks.reversed() {
        if recent.count >= limit { break }
        for f in extractFilesFromToolInput(block["input"]).reversed() {
          if recent.count >= limit { break }
          let key = f.lowercased()
          if seen.insert(key).inserted { recent.append(f) }
        }
      }
    }
    return recent
  }

  private static let noiseTags: [(open: String, close: String, keepInner: Bool)] = [
    ("<system-reminder>", "</system-reminder>", false),
    ("<pasted_content", "</pasted_content", true),
    ("<command-", "</command-", false),
    ("<local-command-", "</local-command-", false),
  ]

  private static func stripTranscriptNoise(_ text: String) -> String {
    var t = text
    for tag in noiseTags {
      var out = ""
      var pos = t.startIndex
      while pos < t.endIndex {
        guard let startRange = t.range(of: tag.open, range: pos..<t.endIndex) else { break }
        let openEnd: String.Index
        if tag.open.hasSuffix(">") {
          openEnd = t.index(before: startRange.upperBound)
        } else {
          guard let gt = t[startRange.upperBound...].firstIndex(of: ">") else { break }
          openEnd = gt
        }
        guard let endRange = t.range(of: tag.close, range: openEnd..<t.endIndex) else { break }
        let closeEnd: String.Index
        if tag.close.hasSuffix(">") {
          closeEnd = t.index(before: endRange.upperBound)
        } else {
          guard let gt = t[endRange.upperBound...].firstIndex(of: ">") else { break }
          closeEnd = gt
        }
        out += t[pos..<startRange.lowerBound]
        if tag.keepInner {
          out += t[t.index(after: openEnd)..<endRange.lowerBound]
        }
        pos = t.index(after: closeEnd)
      }
      t = out + t[pos...]
    }
    return t.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  public static func extractMessagesFromTranscript(transcriptFile: String, maxMessages: Int = 6, maxChars: Int = 400, maxBytes: Int = 512 * 1024) -> [String] {
    let lines = readTailLines(transcriptFile, maxBytes: maxBytes)
    guard !lines.isEmpty else { return [] }
    var collected: [String] = []
    for line in lines.reversed() {
      if collected.count >= maxMessages { break }
      let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
      if trimmed.isEmpty { continue }
      guard let rec = try? JSONValue.parse(trimmed), case .object = rec, rec["isSidechain"] != .bool(true) else { continue }
      let type = rec["type"]?.stringValue ?? ""
      guard type == "user" || type == "assistant", let msg = rec["message"], case .object = msg else { continue }

      let parts: [JSONValue]
      if let s = msg["content"]?.stringValue {
        parts = [["type": "text", "text": .string(s)]]
      } else if let arr = msg["content"]?.arrayValue {
        parts = arr
      } else {
        parts = []
      }
      if type == "user" && parts.contains(where: { $0["type"] == "tool_result" }) { continue }
      let joined = parts
        .filter { $0["type"] == "text" && $0["text"]?.stringValue != nil }
        .compactMap { $0["text"]?.stringValue }
        .joined(separator: "\n")
      let text = stripTranscriptNoise(joined)
      if text.isEmpty { continue }
      collected.append(String(text.prefix(maxChars)))
    }
    return collected.reversed()
  }

  /** Normalizes a `DesktopSession` and optional transcript file into a `SessionContext`. */
  public static func harvestDesktopSession(_ s: DesktopSession, transcriptFile: String?) -> SessionContext {
    let project = (s.project == "(no folder)" || s.project.isEmpty) ? basenameOf(s.cwd) : s.project
    let recentFiles = transcriptFile.map { extractRecentFiles(transcriptFile: $0) } ?? []
    let lastMessages = transcriptFile.map { extractMessagesFromTranscript(transcriptFile: $0) } ?? []
    let lastActivityAt = s.lastActivityAt > 0 ? s.lastActivityAt : (s.lastFocusedAt > 0 ? s.lastFocusedAt : s.createdAt)
    return SessionContext(
      id: String(s.id.prefix(160)),
      title: s.title.isEmpty ? "(untitled)" : String(s.title.prefix(300)),
      project: String(project.prefix(120)),
      cwd: String(s.cwd.prefix(500)),
      branch: s.branch.map { String($0.prefix(160)) },
      status: "idle",
      waiting: false,
      working: false,
      lastActivityAt: lastActivityAt,
      lastFocusedAt: s.lastFocusedAt,
      recentFiles: Array(recentFiles.prefix(12)),
      lastMessages: lastMessages,
      recentCommits: []
    )
  }
}

// MARK: - Per-Session FIFO Prompt Queue

/**
 * Bounded, expiring per-session FIFO prompt queue for busy turns (src/router/queue.js).
 * CRITICAL: `takeNextIfReady` ALWAYS returns `nil` if `working == true` OR `waiting == true` so a
 * queued prompt can never accidentally answer a permission or question prompt.
 */
public final class PromptQueue: @unchecked Sendable {
  public static let maxPromptChars = 32_000

  public struct Item: Sendable, Equatable {
    public let id: String
    public let sessionId: String
    public let prompt: String
    public let meta: [String: JSONValue]?
    public let enqueuedAt: Double
    public let expiresAt: Double
  }

  public struct EnqueueResult: Sendable, Equatable {
    public let ok: Bool
    public let error: String?
    public let maxPerSession: Int?
    public let id: String?
    public let position: Int?
    public let item: Item?
  }

  public struct CancelResult: Sendable, Equatable {
    public let ok: Bool
    public let removed: [Item]
    public let count: Int
  }

  private let cap: Int
  private let ttlMs: Double
  private let clock: @Sendable () -> Double
  private let lock = NSLock()
  private var buckets: [String: [Item]] = [:]
  private var seq = 0

  public init(
    maxPerSession: Int = 5,
    maxAgeMs: Double = 30 * 60_000,
    now: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 * 1000 }
  ) {
    self.cap = max(1, min(100, maxPerSession))
    if maxAgeMs.isFinite && maxAgeMs > 0 {
      self.ttlMs = min(maxAgeMs, 24 * 60 * 60_000)
    } else {
      self.ttlMs = 30 * 60_000
    }
    self.clock = now
  }

  private func currentTimeMs() -> Double {
    let ts = clock()
    return ts.isFinite ? ts : Date().timeIntervalSince1970 * 1000
  }

  private func pruneBucketLocked(_ sessionId: String, currentMs: Double) -> [Item]? {
    guard let items = buckets[sessionId], !items.isEmpty else {
      buckets.removeValue(forKey: sessionId)
      return nil
    }
    let kept = items.filter { currentMs < $0.expiresAt }
    if kept.isEmpty {
      buckets.removeValue(forKey: sessionId)
      return nil
    }
    if kept.count != items.count {
      buckets[sessionId] = kept
    }
    return kept
  }

  private func pruneAllLocked(currentMs: Double) {
    for sid in Array(buckets.keys) {
      _ = pruneBucketLocked(sid, currentMs: currentMs)
    }
  }

  @discardableResult
  public func enqueue(sessionId: String, prompt: String, meta: [String: JSONValue]? = nil) -> EnqueueResult {
    let sid = sessionId.trimmingCharacters(in: .whitespacesAndNewlines)
    let text = String(prompt.trimmingCharacters(in: .whitespacesAndNewlines).prefix(Self.maxPromptChars))
    guard !sid.isEmpty, !text.isEmpty else {
      return EnqueueResult(ok: false, error: "invalid_input", maxPerSession: nil, id: nil, position: nil, item: nil)
    }

    return lock.withLock {
      let currentMs = currentTimeMs()
      var items = pruneBucketLocked(sid, currentMs: currentMs) ?? []
      if items.count >= cap {
        return EnqueueResult(ok: false, error: "queue_full", maxPerSession: cap, id: nil, position: nil, item: nil)
      }
      seq += 1
      let item = Item(
        id: "q_\(seq)",
        sessionId: sid,
        prompt: text,
        meta: meta,
        enqueuedAt: currentMs,
        expiresAt: currentMs + ttlMs
      )
      items.append(item)
      buckets[sid] = items
      return EnqueueResult(ok: true, error: nil, maxPerSession: nil, id: item.id, position: items.count, item: item)
    }
  }

  public func list(sessionId: String? = nil) -> [Item] {
    lock.withLock {
      let currentMs = currentTimeMs()
      if let rawSid = sessionId?.trimmingCharacters(in: .whitespacesAndNewlines), !rawSid.isEmpty {
        return pruneBucketLocked(rawSid, currentMs: currentMs) ?? []
      }
      pruneAllLocked(currentMs: currentMs)
      var all: [Item] = []
      for items in buckets.values { all.append(contentsOf: items) }
      all.sort { $0.enqueuedAt != $1.enqueuedAt ? $0.enqueuedAt < $1.enqueuedAt : $0.id < $1.id }
      return all
    }
  }

  public func peek(sessionId: String) -> Item? {
    let sid = sessionId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !sid.isEmpty else { return nil }
    return lock.withLock {
      pruneBucketLocked(sid, currentMs: currentTimeMs())?.first
    }
  }

  @discardableResult
  public func cancel(_ idOrSessionId: String, itemId: String? = nil) -> CancelResult {
    let first = idOrSessionId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !first.isEmpty else { return CancelResult(ok: false, removed: [], count: 0) }

    return lock.withLock {
      pruneAllLocked(currentMs: currentTimeMs())

      // Form: cancel(sessionId, itemId)
      if let targetId = itemId?.trimmingCharacters(in: .whitespacesAndNewlines), !targetId.isEmpty {
        guard var items = buckets[first], let idx = items.firstIndex(where: { $0.id == targetId }) else {
          return CancelResult(ok: false, removed: [], count: 0)
        }
        let removed = items.remove(at: idx)
        if items.isEmpty { buckets.removeValue(forKey: first) } else { buckets[first] = items }
        return CancelResult(ok: true, removed: [removed], count: 1)
      }

      // Form: cancel(itemId)
      for (sid, var items) in buckets {
        if let idx = items.firstIndex(where: { $0.id == first }) {
          let removed = items.remove(at: idx)
          if items.isEmpty { buckets.removeValue(forKey: sid) } else { buckets[sid] = items }
          return CancelResult(ok: true, removed: [removed], count: 1)
        }
      }

      // Form: cancel(sessionId)
      if let removed = buckets.removeValue(forKey: first) {
        return CancelResult(ok: true, removed: removed, count: removed.count)
      }

      return CancelResult(ok: false, removed: [], count: 0)
    }
  }

  @discardableResult
  public func clearAll() -> Int {
    lock.withLock {
      let total = buckets.values.reduce(0) { $0 + $1.count }
      buckets.removeAll()
      return total
    }
  }

  /**
   * Dequeues the next prompt for `sessionId` ONLY when the session is neither working NOR waiting.
   * CRITICAL: Always returns `nil` if `working == true` OR `waiting == true`.
   */
  public func takeNextIfReady(sessionId: String, working: Bool = false, waiting: Bool = false) -> Item? {
    if working || waiting { return nil }
    let sid = sessionId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !sid.isEmpty else { return nil }

    return lock.withLock {
      guard var items = pruneBucketLocked(sid, currentMs: currentTimeMs()), !items.isEmpty else {
        return nil
      }
      let next = items.removeFirst()
      if items.isEmpty { buckets.removeValue(forKey: sid) } else { buckets[sid] = items }
      return next
    }
  }
}
