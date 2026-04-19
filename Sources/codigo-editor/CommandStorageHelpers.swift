import Foundation

func normaliseDirectoryKey(_ raw: String) -> String {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else {
        return ""
    }

    if trimmed == "/" || trimmed == "\\" {
        return "/"
    }

    let pattern = #"[\\/]+$"#
    let stripped = trimmed.replacingOccurrences(of: pattern, with: "", options: .regularExpression)
    if stripped.isEmpty {
        return "/"
    }

    if stripped.count == 2,
       let first = stripped.first,
       first.isLetter,
       stripped.last == ":" {
        return "\(stripped)\\"
    }

    return stripped
}

func sanitizeCommands(_ commands: [String]) -> [String] {
    var seen = Set<String>()
    var result: [String] = []
    for value in commands {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            continue
        }
        if seen.insert(trimmed).inserted {
            result.append(trimmed)
        }
    }
    return result
}

func sanitizeCommandsByPath(_ commands: [String: [String]]) -> [String: [String]] {
    var result: [String: [String]] = [:]
    for (rawKey, values) in commands {
        let key = normaliseDirectoryKey(rawKey)
        let sanitized = sanitizeCommands(values)
        if sanitized.isEmpty {
            result[key] = []
            continue
        }
        if var existing = result[key] {
            for command in sanitized where !existing.contains(command) {
                existing.append(command)
            }
            result[key] = existing
        } else {
            result[key] = sanitized
        }
    }
    return result
}

func sanitizeLinks(_ links: [String]) -> [String] {
    return sanitizeCommands(links)
}

func sanitizeLinksByPath(_ links: [String: [String]]) -> [String: [String]] {
    var result: [String: [String]] = [:]
    for (rawKey, values) in links {
        let key = normaliseDirectoryKey(rawKey)
        let sanitized = sanitizeLinks(values)
        if sanitized.isEmpty {
            result[key] = []
            continue
        }
        if var existing = result[key] {
            for link in sanitized where !existing.contains(link) {
                existing.append(link)
            }
            result[key] = existing
        } else {
            result[key] = sanitized
        }
    }
    return result
}
