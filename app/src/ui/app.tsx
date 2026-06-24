@@
   private onUpdateAvailableDismissed = () =>
     this.props.dispatcher.setUpdateBannerVisibility(false)
@@
-    ipcRenderer.on('menu-event', (_, name) => this.onMenuEvent(name))
+    ipcRenderer.on('menu-event', (_, name) => this.onMenuEvent(name))
+    // listen for preference changes made in Preferences UI
+    window.addEventListener(
+      'always-show-repositories-pane-changed',
+      this.onAlwaysShowRepositoriesPaneChanged
+    )
@@
   public componentWillUnmount() {
     window.clearInterval(this.updateIntervalHandle)
@@
     if (__DARWIN__) {
       window.removeEventListener('keydown', this.onMacOSWindowKeyDown)
     }
+    window.removeEventListener(
+      'always-show-repositories-pane-changed',
+      this.onAlwaysShowRepositoriesPaneChanged
+    )
   }
+
+  private onAlwaysShowRepositoriesPaneChanged = () => {
+    // Trigger a re-render so app can check localStorage for updated preference
+    this.forceUpdate()
+  }
@@
-    return (
-      <div
-        id="desktop-app-contents"
-        className={this.getDesktopAppContentsClassNames()}
-      >
-        {this.renderToolbar()}
-        {this.renderBanner()}
-        {this.renderRepository()}
-        {this.renderPopups()}
-        {this.renderDragElement()}
-      </div>
-    )
+    const alwaysShow =
+      localStorage.getItem('desktop:alwaysShowRepositoriesPane:v1') === 'true'
+
+    return (
+      <div
+        id="desktop-app-contents"
+        className={this.getDesktopAppContentsClassNames()}
+      >
+        {this.renderToolbar()}
+        {this.renderBanner()}
+        {alwaysShow ? (
+          <div style={{ display: 'flex', height: '100%' }}>
+            <aside
+              id="repository-sidebar"
+              style={{ width: clamp(this.state.sidebarWidth), minWidth: clamp(this.state.sidebarWidth) }}
+            >
+              {this.renderRepositoryList()}
+            </aside>
+            <main style={{ flex: 1, overflow: 'hidden' }}>{this.renderRepository()}</main>
+          </div>
+        ) : (
+          this.renderRepository()
+        )}
+
+        {this.renderPopups()}
+        {this.renderDragElement()}
+      </div>
+    )
   }
*** End Patch