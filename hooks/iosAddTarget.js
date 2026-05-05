const fs = require('fs');
const path = require('path');

const {
  PLUGIN_ID,
  iosFolder,
  getPreferences,
  findXCodeproject,
  replacePreferencesInFile,
  log, redError,
} = require('./utils')

// Return the list of files in the share extension project, organized by type
const FILE_TYPES = {
  '.h':'source',
  '.m':'source',
  '.plist':'config',
  '.entitlements':'config',
};

function parsePbxProject(context, pbxProjectPath) {
  var xcode = require('xcode');
  log(`Parsing existing project at location: ${pbxProjectPath}…`);

  var pbxProject;

  if (context.opts.cordova.project) {
    pbxProject = context.opts.cordova.project.parseProjectFile(context.opts.projectRoot).xcode;
  } else {
    pbxProject = xcode.project(pbxProjectPath);
    pbxProject.parseSync();
  }

  return pbxProject;
}

function forEachShareExtensionFile(context, callback) {
  var shareExtensionFolder = path.join(iosFolder(context), 'ShareExtension');
  fs.readdirSync(shareExtensionFolder).forEach(function(name) {
    if (!/^\..*/.test(name)) {
      callback({
        name: name,
        path: path.join(shareExtensionFolder, name),
        extension: path.extname(name)
      });
    }
  });
}

function getShareExtensionFiles(context) {
  var files = { source: [], config: [], resource: [] };

  forEachShareExtensionFile(context, function(file) {
    var fileType = FILE_TYPES[file.extension] || 'resource';
    files[fileType].push(file);
  });

  return files;
}

module.exports = function(context) {
  log('Adding ShareExt target to XCode project')

  var deferral = require('q').defer();

  findXCodeproject(context, function(projectFolder, projectName) {

    var preferences = getPreferences(context, projectName);
    var pbxProjectPath = path.join(projectFolder, 'project.pbxproj');
    var pbxProject = parsePbxProject(context, pbxProjectPath);

    var files = getShareExtensionFiles(context);

    files.config.concat(files.source).forEach(function(file) {
      replacePreferencesInFile(file.path, preferences);
    });

    // Check if target already exists
    var target = pbxProject.pbxTargetByName('ShareExt') || pbxProject.pbxTargetByName('"ShareExt"');
    if (target) {
      log('ShareExt target already exists')
    }

    if (!target) {
      target = pbxProject.addTarget('ShareExt', 'app_extension', 'ShareExtension');

      pbxProject.addBuildPhase([], 'PBXSourcesBuildPhase', 'Sources', target.uuid);
      pbxProject.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', target.uuid);
    }

    // Create group
    var pbxGroupKey = pbxProject.findPBXGroupKey({name: 'ShareExtension'});

    if (pbxGroupKey) {
      log('ShareExtension group already exists')
    } else {
      pbxGroupKey = pbxProject.pbxCreateGroup('ShareExtension', 'ShareExtension');

      var customTemplateKey = pbxProject.findPBXGroupKey({name: 'CustomTemplate'});
      pbxProject.addToPbxGroup(pbxGroupKey, customTemplateKey);
    }

    // Add config files
    files.config.forEach(function (file) {
      pbxProject.addFile(file.name, pbxGroupKey);
    });

    // Add source files
    files.source.forEach(function(file) {
      pbxProject.addSourceFile(file.name, {target: target.uuid}, pbxGroupKey);
    });

    // Add resource files
    files.resource.forEach(function(file) {
      pbxProject.addResourceFile(file.name, {target: target.uuid}, pbxGroupKey);
    });

    // 🔥 FINAL FIX — MUST BE AT END
    var configurations = pbxProject.pbxXCBuildConfigurationSection();

    for (var key in configurations) {
      if (typeof configurations[key].buildSettings !== 'undefined') {

        var buildSettingsObj = configurations[key].buildSettings;

        // ✅ Apply to ALL targets and configs
        buildSettingsObj['LD_RUNPATH_SEARCH_PATHS'] = '$(inherited)';
        buildSettingsObj['FRAMEWORK_SEARCH_PATHS'] = '$(inherited)';
        buildSettingsObj['HEADER_SEARCH_PATHS'] = '$(inherited)';

        // ✅ Only for Share Extension
        if (buildSettingsObj['PRODUCT_NAME'] &&
            buildSettingsObj['PRODUCT_NAME'].indexOf('ShareExt') >= 0) {

          buildSettingsObj['CODE_SIGN_ENTITLEMENTS'] =
            '"ShareExtension/ShareExtension.entitlements"';
        }
      }
    }

    // Write project
    fs.writeFileSync(pbxProjectPath, pbxProject.writeSync());

    log('Successfully added ShareExt target to XCode project')

    deferral.resolve();
  });

  return deferral.promise;
};
