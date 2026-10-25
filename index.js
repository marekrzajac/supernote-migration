/**
 * @format
 */

import {AppRegistry, Image} from 'react-native';
import App from './App';
import {name as appName} from './app.json';

import { PluginManager } from 'sn-plugin-lib';

AppRegistry.registerComponent(appName, () => App);

PluginManager.init();

// ---------------------------------------------------------------------------
// Real buttons first.
//
// v0.0.10 registered an experimental button *before* these, calling the native
// module directly with an undocumented 4th argument. That call threw
// synchronously — and a synchronous throw during module evaluation aborts the
// rest of index.js, so NONE of the buttons below ever registered and the plugin
// vanished from the extensions menu entirely.
//
// Two lessons, both encoded here: register the things that must work first, and
// guard anything experimental with try/catch (a .catch() on the promise only
// covers rejection, not a synchronous throw from the bridge).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Button IDs must be globally unique, NOT just unique within this plugin.
//
// The scaffold template ships with ids 100/200/300, and so does every other
// plugin built from it. The InkHub "Sticker" plugin also uses id=100 for its
// sidebar button — and the host collapses sidebar entries by id, so only one
// survives. Ours silently vanished from the Plugins menu the moment a sticker
// plugin was installed:
//
//   ToolbarConfigManager: PluginSideButton : id=100, name=Sticker
//   onSideButtonDataChange list:1        <- our Side Button never arrives
//
// Hence a private range (71xx before the rename to Nomad ↔ Manta, 72xx since,
// so the old and new plugins can't collide if both are installed). The docs call this field "unique and immutable,
// defined by plugin" — which evidently means unique across all plugins.
// ---------------------------------------------------------------------------

PluginManager.registerButton(1, ['NOTE', 'DOC'], {
  id: 7201,
  name: 'Migration',
  icon: Image.resolveAssetSource(
    require('./assets/icon.png'),
  ).uri,
  showType: 1,
});

// The scaffold's Lasso and Selection toolbar buttons were removed: they did
// nothing for this plugin and showed up as "Lasso Button" in the lasso toolbar.

// ---------------------------------------------------------------------------
// REMOVED: the `showData` / regionType panel experiment.
//
// `NativePluginManager.registerButtonRes` accepts exactly THREE JS arguments.
// Passing the documented 4th (`showData`) produces, on the native side:
//
//   NativeArgumentsParseException:
//     NativePluginManager.registerButtonRes got 6 arguments, expected 5
//   (3 JS args + promise resolve/reject = 5)
//
// and the host's PluginJSExceptionHandler responds by tearing the plugin down
// immediately — closePlugin → onHostPause → onHostDestroy → visibility:8.
// Net effect: the sidebar button appears, and tapping it does nothing at all.
//
// try/catch does NOT protect against this. The error is raised asynchronously
// by the native bridge, not thrown synchronously in JS, so nothing on the JS
// side ever sees it.
//
// So regionType is not reachable from JS in sn-plugin-lib 0.2.3, even though
// the native docblock describes it. If the panel idea is revisited, the places
// left to look are PluginConfig.json (the host stores a `showData` column on
// its button entity, always null for us) or registerConfigButton().
// ---------------------------------------------------------------------------