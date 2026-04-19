import AppKit
import Foundation

@MainActor
final class StarterCommandPrompt {
    struct Result {
        let preset: StarterPreset
        let command: String
    }

    func run(currentCommand: String) -> Result? {
        let alert = NSAlert()
        alert.messageText = "Choose Your Default CLI"
        alert.informativeText = "Select the command Codigo should run for new terminals."
        alert.alertStyle = .informational
        alert.addButton(withTitle: "Continue")
        alert.addButton(withTitle: "Cancel")

        let accessor = SelectionController(currentCommand: currentCommand)
        alert.accessoryView = accessor.makeAccessoryView()

        let response = alert.runModal()
        guard response == .alertFirstButtonReturn else {
            return nil
        }

        let preset = accessor.selectedPreset
        let command: String
        if let presetCommand = preset.command {
            command = presetCommand
        } else {
            let raw = accessor.customField?.stringValue ?? ""
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else {
                NSSound.beep()
                return nil
            }
            command = trimmed
        }
        return Result(preset: preset, command: command)
    }

    @MainActor
    private final class SelectionController: NSObject {
        private(set) var selectedPreset: StarterPreset
        private let initialPreset: StarterPreset
        private let initialCommand: String
        private var radioButtons: [StarterPreset: NSButton] = [:]
        weak var customField: NSTextField?

        init(currentCommand: String) {
            let preset = StarterPreset.preset(for: currentCommand)
            self.selectedPreset = preset
            self.initialPreset = preset
            self.initialCommand = currentCommand.trimmingCharacters(in: .whitespacesAndNewlines)
        }

        override init() {
            fatalError("Use init(currentCommand:)")
        }

        func makeAccessoryView() -> NSView {
            let container = NSStackView()
            container.orientation = .vertical
            container.alignment = .leading
            container.spacing = 12
            container.edgeInsets = NSEdgeInsets(top: 4, left: 0, bottom: 0, right: 0)

            for preset in StarterPreset.allCases {
                let item = makePresetRow(for: preset)
                container.addArrangedSubview(item)
            }

            syncRadioStates()
            updateCustomFieldState()

            container.layoutSubtreeIfNeeded()
            let fitting = container.fittingSize
            let width = max(320, fitting.width)
            container.setFrameSize(NSSize(width: width, height: fitting.height))

            return container
        }

        private func makePresetRow(for preset: StarterPreset) -> NSView {
            let radio = NSButton(radioButtonWithTitle: preset.title, target: self, action: #selector(togglePreset(_:)))
            radio.setButtonType(.radio)
            radio.translatesAutoresizingMaskIntoConstraints = false
            radio.setContentCompressionResistancePriority(.required, for: .horizontal)
            radioButtons[preset] = radio
            if preset == selectedPreset {
                radio.state = .on
            }

            let description = NSTextField(labelWithString: preset.description)
            description.font = NSFont.systemFont(ofSize: NSFont.smallSystemFontSize)
            description.textColor = NSColor.secondaryLabelColor
            description.lineBreakMode = .byWordWrapping
            description.maximumNumberOfLines = 2
            description.translatesAutoresizingMaskIntoConstraints = false

            let column = NSStackView()
            column.orientation = .vertical
            column.alignment = .leading
            column.spacing = 2
            column.translatesAutoresizingMaskIntoConstraints = false
            column.addArrangedSubview(radio)
            column.addArrangedSubview(description)

            if preset == .custom {
                let field = NSTextField(string: initialPreset == .custom ? initialCommand : "")
                field.placeholderString = "Custom command"
                field.isEnabled = (selectedPreset == .custom)
                field.translatesAutoresizingMaskIntoConstraints = false
                field.preferredMaxLayoutWidth = 280
                field.target = self
                field.action = #selector(customFieldEdited(_:))
                self.customField = field
                column.addArrangedSubview(field)
            }

            let wrapper = NSView()
            wrapper.translatesAutoresizingMaskIntoConstraints = false
            wrapper.addSubview(column)

            NSLayoutConstraint.activate([
                column.leadingAnchor.constraint(equalTo: wrapper.leadingAnchor),
                column.trailingAnchor.constraint(equalTo: wrapper.trailingAnchor),
                column.topAnchor.constraint(equalTo: wrapper.topAnchor),
                column.bottomAnchor.constraint(equalTo: wrapper.bottomAnchor)
            ])

            return wrapper
        }

        @objc private func togglePreset(_ sender: NSButton) {
            guard let entry = radioButtons.first(where: { $0.value === sender }) else {
                return
            }
            selectedPreset = entry.key
            updateCustomFieldState()
            syncRadioStates()
        }

        @objc private func customFieldEdited(_ sender: NSTextField) {
            if selectedPreset != .custom {
                selectedPreset = .custom
                syncRadioStates()
            }
        }

        private func syncRadioStates() {
            radioButtons.forEach { preset, button in
                button.state = (preset == selectedPreset) ? .on : .off
            }
        }

        private func updateCustomFieldState() {
            let enabled = selectedPreset == .custom
            if let field = customField {
                field.isEnabled = enabled
                if enabled {
                    DispatchQueue.main.async {
                        field.window?.makeFirstResponder(field)
                    }
                }
            }
        }
    }
}
