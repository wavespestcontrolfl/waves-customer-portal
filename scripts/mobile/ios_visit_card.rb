#!/usr/bin/env ruby
# frozen_string_literal: true

# ios_visit_card.rb: put the Lock Screen visit card into the generated customer iOS project
# (docs/mobile/live-activity.md). scripts/mobile/bootstrap-ios.sh runs it, through the Ruby CocoaPods runs
# on (it needs the xcodeproj gem), only when WAVES_IOS_VISIT_CARD=1.
#
#   ruby ios_visit_card.rb <client/ios/App> <client/resources/visit-card>
#
# What it does, each step safe to run again:
#   1. Copies the tracked Swift sources into the project.
#   2. Compiles the plugin and the card's data type into the App target.
#   3. Makes the WavesVisitCard widget extension target (iOS 18, the floor of a card that listens on an
#      Apple channel), with the App target's version, build number and signing team.
#   4. Embeds the extension in the app, ahead of the CocoaPods script phases.
#   5. Sets NSSupportsLiveActivities in the app's Info.plist.
#   6. Adds the plugin class to packageClassList in the generated capacitor.config.json, which is how
#      Capacitor registers a plugin at launch. `npx cap sync` rewrites that file, so run this after it.

require "fileutils"
require "json"
require "xcodeproj"

EXTENSION = "WavesVisitCard"
EXTENSION_FLOOR = "18.0"
PLUGIN_CLASS = "WavesVisitCardPlugin"
SHARED_SOURCE = "WavesVisitAttributes.swift"
PLUGIN_SOURCE = "WavesVisitCardPlugin.swift"
WIDGET_SOURCE = "WavesVisitCardWidget.swift"
EMBED_PHASE = "Embed Foundation Extensions"
# Settings the extension must share with the app: App Store Connect refuses an extension whose version or
# build number differs from its app's, and both are signed by one team.
MIRRORED_SETTINGS = %w[MARKETING_VERSION CURRENT_PROJECT_VERSION DEVELOPMENT_TEAM CODE_SIGN_STYLE SWIFT_VERSION TARGETED_DEVICE_FAMILY].freeze

project_dir = ARGV[0]
sources_dir = ARGV[1]
abort("usage: ios_visit_card.rb <client/ios/App> <client/resources/visit-card>") unless project_dir && sources_dir

def add_source(target, ref)
  phase = target.source_build_phase
  phase.add_file_reference(ref, true) unless phase.files_references.include?(ref)
end

def reference(group, name)
  group.files.find { |file| file.path == name } || group.new_reference(name)
end

project = Xcodeproj::Project.open(File.join(project_dir, "App.xcodeproj"))
app = project.targets.find { |target| target.name == "App" } or abort("no App target")
app_group = project.main_group.find_subpath("App", false) or abort("no App group")
bundle_id = app.build_configurations.map { |config| config.build_settings["PRODUCT_BUNDLE_IDENTIFIER"] }.compact.uniq
abort("the App target needs one literal PRODUCT_BUNDLE_IDENTIFIER") unless bundle_id.length == 1 && !bundle_id[0].include?("$")

# 1. Sources. The plugin lives with the app; the card's data type and its drawing live with the extension.
extension_dir = File.join(project_dir, EXTENSION)
FileUtils.mkdir_p(extension_dir)
FileUtils.cp(File.join(sources_dir, PLUGIN_SOURCE), File.join(project_dir, "App", PLUGIN_SOURCE))
[SHARED_SOURCE, WIDGET_SOURCE, "Info.plist"].each do |name|
  FileUtils.cp(File.join(sources_dir, name), File.join(extension_dir, name))
end

# 2 + 3. One reference to the data type, compiled into both targets, so the two can never disagree.
extension = project.targets.find { |target| target.name == EXTENSION } ||
            project.new_target(:app_extension, EXTENSION, :ios, EXTENSION_FLOOR, nil, :swift)
extension_group = project.main_group[EXTENSION] || project.main_group.new_group(EXTENSION, EXTENSION)
shared = reference(extension_group, SHARED_SOURCE)
add_source(app, reference(app_group, PLUGIN_SOURCE))
add_source(app, shared)
add_source(extension, shared)
add_source(extension, reference(extension_group, WIDGET_SOURCE))
reference(extension_group, "Info.plist")

extension.build_configurations.each do |config|
  app_config = app.build_configurations.find { |candidate| candidate.name == config.name } or abort("App has no #{config.name} configuration")
  settings = config.build_settings
  settings["PRODUCT_NAME"] = "$(TARGET_NAME)"
  settings["PRODUCT_BUNDLE_IDENTIFIER"] = "#{bundle_id[0]}.VisitCard"
  settings["INFOPLIST_FILE"] = "#{EXTENSION}/Info.plist"
  settings["GENERATE_INFOPLIST_FILE"] = "NO"
  settings["IPHONEOS_DEPLOYMENT_TARGET"] = EXTENSION_FLOOR
  settings["SKIP_INSTALL"] = "YES"
  settings["LD_RUNPATH_SEARCH_PATHS"] = ["$(inherited)", "@executable_path/Frameworks", "@executable_path/../../Frameworks"]
  MIRRORED_SETTINGS.each do |key|
    value = app_config.build_settings[key]
    if value.nil? then settings.delete(key) else settings[key] = value end
  end
  settings["SWIFT_VERSION"] ||= "5.0"
end

# 4. Embedded in the app. The phase goes right after the app's resources: placed after the CocoaPods script
# phases, Xcode reports a dependency cycle between the two.
embed = app.copy_files_build_phases.find { |phase| phase.name == EMBED_PHASE } || app.new_copy_files_build_phase(EMBED_PHASE)
embed.symbol_dst_subfolder_spec = :plug_ins
unless embed.files_references.include?(extension.product_reference)
  embedded = embed.add_file_reference(extension.product_reference, true)
  embedded.settings = { "ATTRIBUTES" => ["RemoveHeadersOnCopy"] }
end
app.build_phases.move(embed, app.build_phases.index(app.resources_build_phase) + 1)
app.add_dependency(extension) unless app.dependencies.any? { |dependency| dependency.target == extension }
project.save

# 5. Without this key iOS starts no Live Activity for the app.
info_path = File.join(project_dir, "App", "Info.plist")
info = Xcodeproj::Plist.read_from_path(info_path)
unless info["NSSupportsLiveActivities"] == true
  info["NSSupportsLiveActivities"] = true
  Xcodeproj::Plist.write_to_path(info, info_path)
end

# 6. Capacitor registers the classes this list names when the app starts.
config_path = File.join(project_dir, "App", "capacitor.config.json")
abort("no generated capacitor.config.json: run `npx cap sync ios` first") unless File.exist?(config_path)
config = JSON.parse(File.read(config_path))
classes = config["packageClassList"] ||= []
unless classes.include?(PLUGIN_CLASS)
  classes << PLUGIN_CLASS
  File.write(config_path, "#{JSON.pretty_generate(config)}\n")
end

puts "Lock Screen visit card: #{PLUGIN_CLASS} in the App target, #{EXTENSION} (iOS #{EXTENSION_FLOOR}+, #{bundle_id[0]}.VisitCard) embedded"
