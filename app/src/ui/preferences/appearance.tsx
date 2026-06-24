@@
 import { DateFormat, TimeFormat, INumberFormat, dateFormats, timeFormats, numberFormats, numberFormatToKey, } from '../../models/formatting-preferences'
 import { formatNumber } from '../../lib/format-number'
+import { Checkbox, CheckboxValue } from '../lib/checkbox'
@@
 interface IAppearanceProps {
@@
   readonly onPreferAbsoluteDatesChanged: (value: boolean) => void
+  /** Whether to always show the repositories pane (persisted client-side) */
+  readonly alwaysShowRepositoriesPane?: boolean
+  readonly onAlwaysShowRepositoriesPaneChanged?: (value: boolean) => void
 }
@@
   private onPreferAbsoluteDatesChanged = (
     event: React.FormEvent<HTMLInputElement>
   ) => {
     this.props.onPreferAbsoluteDatesChanged(event.currentTarget.checked)
   }
+
+  private onAlwaysShowRepositoriesPaneChanged = (
+    event: React.FormEvent<HTMLInputElement>
+  ) => {
+    this.props.onAlwaysShowRepositoriesPaneChanged?.(
+      event.currentTarget.checked
+    )
+  }
@@
   public render() {
     return (
       <DialogContent>
         {this.renderSelectedTheme()}
         {this.renderFormatting()}
         {this.renderSelectedTabSize()}
+        <div className="appearance-section">
+          <h2>Repository Pane</h2>
+          <Checkbox
+            label="Always show repositories pane"
+            value={
+              this.props.alwaysShowRepositoriesPane
+                ? CheckboxValue.On
+                : CheckboxValue.Off
+            }
+            onChange={this.onAlwaysShowRepositoriesPaneChanged}
+          />
+          <div className="settings-description">
+            When enabled, the repositories pane will be docked and visible across the app.
+          </div>
+        </div>
       </DialogContent>
     )
   }
 }
