const fs = require('fs');
const path = require('path');

const {
  iosFolder,
  getPreferences,
  findXCodeproject,
  replacePreferencesInFile,
  log
} = require('./utils');

// File type mapping
const FILE_TYPES = {
  '.h': 'source',
  '.m': 'source',
  '.plist': 'config',
  '.entitlements': 'config',
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

  fs.readdirSync(shareExtensionFolder).forEach(function (name) {
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

  forEachShareExtensionFile(context, function (file) {
    var fileType = FILE_TYPES[file.extension] || 'resource';
    files[fileType].push(file);
  });

  return files;
}

module.exports = function (context) {
  log('Adding ShareExt target to XCode project');

  var deferral = require('q').defer();

  findXCodeproject(context, function (projectFolder, projectName) {

    var preferences = getPreferences(context, projectName);
    var pbxProjectPath = path.join(projectFolder, 'project.pbxproj');
    var pbxProject = parsePbxProject(context, pbxProjectPath);

    var files = getShareExtensionFiles(context);

    // Replace placeholders in plist / entitlements
    files.config.concat(files.source).forEach(function (file) {
      replacePreferencesInFile(file.path, preferences);
    });

    // Check if target exists
    var target = pbxProject.pbxTargetByName('ShareExt') || pbxProject.pbxTargetByName('"ShareExt"');

    if (!target) {
      target = pbxProject.addTarget('ShareExt', 'app_extension', 'ShareExtension');

      pbxProject.addBuildPhase([], 'PBXSourcesBuildPhase', 'Sources', target.uuid);
      pbxProject.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', target.uuid);
    } else {
      log('ShareExt target already exists');
    }

    // Create group
    var pbxGroupKey = pbxProject.findPBXGroupKey({ name: 'ShareExtension' });

    if (!pbxGroupKey) {
      pbxGroupKey = pbxProject.pbxCreateGroup('ShareExtension', 'ShareExtension');

      var customTemplateKey = pbxProject.findPBXGroupKey({ name: 'CustomTemplate' });
      pbxProject.addToPbxGroup(pbxGroupKey, customTemplateKey);
    }

    // Add files
    files.config.forEach(function (file) {
      pbxProject.addFile(file.name, pbxGroupKey);
    });

    files.source.forEach(function (file) {
      pbxProject.addSourceFile(file.name, { target: target.uuid }, pbxGroupKey);
    });

    files.resource.forEach(function (file) {
      pbxProject.addResourceFile(file.name, { target: target.uuid }, pbxGroupKey);
    });

    // 🔥 FINAL SIGNING + ENTITLEMENTS FIX
    var configurations = pbxProject.pbxXCBuildConfigurationSection();

    for (var key in configurations) {
      if (typeof configurations[key].buildSettings !== 'undefined') {

        var buildSettingsObj = configurations[key].buildSettings;

        // Apply to all
        buildSettingsObj['LD_RUNPATH_SEARCH_PATHS'] = '$(inherited)';
        buildSettingsObj['FRAMEWORK_SEARCH_PATHS'] = '$(inherited)';
        buildSettingsObj['HEADER_SEARCH_PATHS'] = '$(inherited)';

        // Apply only to Share Extension
        if (buildSettingsObj['PRODUCT_NAME'] &&
          buildSettingsObj['PRODUCT_NAME'].indexOf('ShareExt') >= 0) {

          // Enable automatic signing
          buildSettingsObj['CODE_SIGN_STYLE'] = 'Automatic';

          // 🔥 CRITICAL: inherit team from ANY valid config
          if (!buildSettingsObj['DEVELOPMENT_TEAM'] || buildSettingsObj['DEVELOPMENT_TEAM'] === '') {

            for (var k in configurations) {
              if (configurations[k].buildSettings &&
                configurations[k].buildSettings['DEVELOPMENT_TEAM']) {

                buildSettingsObj['DEVELOPMENT_TEAM'] =
                  configurations[k].buildSettings['DEVELOPMENT_TEAM'];
                break;
              }
            }
          }

          // Remove forced identity (let Xcode decide)
          delete buildSettingsObj['CODE_SIGN_IDENTITY'];

          // Entitlements
          buildSettingsObj['CODE_SIGN_ENTITLEMENTS'] =
            '"ShareExtension/ShareExtension.entitlements"';
        }
      }
    }

    // Write changes
    fs.writeFileSync(pbxProjectPath, pbxProject.writeSync());

    log('Successfully added ShareExt target to XCode project');

    deferral.resolve();
  });

  return deferral.promise;
};
