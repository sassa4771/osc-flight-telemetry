using System.Collections.Generic;
using System.Linq;
using System.Text;
using ClusterVR.CreatorKit.Item.Implements;
using ClusterVR.CreatorKit.World.Implements.PlayerLocalUI;
using TMPro;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;
using UnityEngine.UI;

namespace OscFlightTelemetry.EditorTools
{
    /// <summary>
    /// 開いているシーンに OSC モニター (ワールド空間の PlayerLocalUI) を生成し、
    /// Cube_OSC_Trigger / PlaneBody のスクリプトを Assets/Scripts/OscFlight/*.js に差し替え、
    /// Cube_OSC_Trigger の上に操縦者名を表示する OperatorLabel を作る。
    /// ControlPanel のスクリプトを ControlPanel.js に差し替え、Cube_OSC_Trigger から参照できるようにする (OSC 送信用)。
    /// 何度実行しても同じ状態になる (モニターは作り直し、位置は維持)。
    /// </summary>
    public static class OscFlightMonitorSetup
    {
        const string MenuPath = "Tools/OSC Flight/Setup Monitor In Open Scene";
        const string TriggerName = "Cube_OSC_Trigger";
        const string PlaneBodyName = "PlaneBody";
        const string MonitorName = "OscMonitor";
        const string IdPrefix = "oscmon.";
        const string PlayerScriptPath = "Assets/Scripts/OscFlight/OscFlightPlayer.js";
        const string PlaneBodyScriptPath = "Assets/Scripts/OscFlight/PlaneBody.js";
        const string TriggerScriptPath = "Assets/Scripts/OscFlight/OscTrigger.js";
        const string ControlPanelName = "ControlPanel";
        const string ControlPanelScriptPath = "Assets/Scripts/OscFlight/ControlPanel.js";
        const string OperatorLabelName = "OperatorLabel";
        const float OperatorLabelHeight = 0.95f; // Cube_OSC_Trigger の中心からの高さ (m)

        // ボードは 1600 x 1310 px、1px = 1.5mm (2.4m x 1.97m)
        const float CanvasScale = 0.0015f;
        const float BoardWidth = 1600f;
        const float BoardHeight = 1310f;
        static readonly Vector3 DefaultBoardPosition = new Vector3(0f, 2.1f, -4.2f);
        static readonly Vector3 DefaultBoardEuler = new Vector3(0f, 180f, 0f);

        // ポリラインは不透明描画なので、半透明 UI の背景に隠れないようボードより手前に置く
        const float PlotZ = -3f;                         // px (= 4.5mm)
        const float PreviewZ = -0.30f / CanvasScale;     // px (= 30cm)
        static readonly Vector3 PreviewEuler = new Vector3(-30f, 30f, 0f); // 斜め後ろ上から見る

        static readonly Color BoardColor = new Color(0.06f, 0.07f, 0.09f, 1f);
        static readonly Color CardColor = new Color(0.11f, 0.12f, 0.15f, 1f);
        static readonly Color GraphColor = new Color(0.03f, 0.035f, 0.045f, 1f);
        static readonly Color TextColor = new Color(0.9f, 0.92f, 0.95f, 1f);

        [MenuItem(MenuPath)]
        public static void Setup()
        {
            var scene = SceneManager.GetActiveScene();
            var report = new StringBuilder();
            if (!Run(scene, report, out var error))
            {
                Fail(error);
                return;
            }
            var message = report.ToString();
            Debug.Log($"[OSC Flight] セットアップ完了\n{message}");
            EditorUtility.DisplayDialog("OSC Flight Monitor",
                $"セットアップしました。シーンを保存してください (Ctrl+S)。\n\n{message}", "OK");
        }

        /// <summary>セットアップ本体。失敗したら false と理由を返す (その場合シーンは変更しない)。</summary>
        internal static bool Run(Scene scene, StringBuilder report, out string error)
        {
            error = null;
            if (!scene.IsValid() || !scene.isLoaded)
            {
                error = "シーンが開かれていません。";
                return false;
            }

            var trigger = FindInScene(scene, TriggerName);
            var playerScript = trigger != null ? trigger.GetComponent<PlayerScript>() : null;
            if (playerScript == null)
            {
                error = $"PlayerScript を持つ '{TriggerName}' がシーンに見つかりません。";
                return false;
            }

            AssetDatabase.ImportAsset(PlayerScriptPath);
            AssetDatabase.ImportAsset(PlaneBodyScriptPath);
            AssetDatabase.ImportAsset(TriggerScriptPath);
            AssetDatabase.ImportAsset(ControlPanelScriptPath);
            var playerJs = AssetDatabase.LoadAssetAtPath<JavaScriptAsset>(PlayerScriptPath);
            var planeJs = AssetDatabase.LoadAssetAtPath<JavaScriptAsset>(PlaneBodyScriptPath);
            var triggerJs = AssetDatabase.LoadAssetAtPath<JavaScriptAsset>(TriggerScriptPath);
            var panelJs = AssetDatabase.LoadAssetAtPath<JavaScriptAsset>(ControlPanelScriptPath);
            if (playerJs == null)
            {
                error = $"{PlayerScriptPath} を JavaScriptAsset として読み込めません。";
                return false;
            }

            Undo.SetCurrentGroupName("Setup OSC Flight Monitor");
            var undoGroup = Undo.GetCurrentGroup();

            // 1. モニター (PlayerLocalUI) を作り直す。Item の子にすると PlayerScript から操作できないのでシーン直下に置く
            var position = DefaultBoardPosition;
            var rotation = Quaternion.Euler(DefaultBoardEuler);
            var existing = scene.GetRootGameObjects().FirstOrDefault(g => g.name == MonitorName);
            if (existing != null)
            {
                position = existing.transform.position;
                rotation = existing.transform.rotation;
                Undo.DestroyObjectImmediate(existing);
            }
            var refs = new Dictionary<string, GameObject>();
            var monitor = BuildMonitor(refs);
            SceneManager.MoveGameObjectToScene(monitor, scene);
            monitor.transform.SetPositionAndRotation(position, rotation);
            Undo.RegisterCreatedObjectUndo(monitor, "Create OSC Monitor");
            report.AppendLine($"- {MonitorName} を生成 (位置 {position})");

            // 2. Cube_OSC_Trigger: PlayerScript を JS アセットに差し替え、UI 参照を登録
            SetSourceCodeAsset(playerScript, playerJs);
            report.AppendLine($"- {TriggerName} の PlayerScript → {PlayerScriptPath}");
            SetPlayerLocalReferences(trigger, refs);
            report.AppendLine($"- {TriggerName} の PlayerLocalObjectReferenceList に {refs.Count} 件登録");

            // 2b. Cube_OSC_Trigger: ScriptableItem を OscTrigger.js に差し替え、操縦者名ラベルを作る
            var triggerItem = trigger.GetComponent<ScriptableItem>();
            if (triggerItem != null && triggerJs != null)
            {
                SetSourceCodeAsset(triggerItem, triggerJs);
                report.AppendLine($"- {TriggerName} の ScriptableItem → {TriggerScriptPath}");
                BuildOperatorLabel(trigger);
                report.AppendLine($"- {TriggerName} の子に {OperatorLabelName} を生成");
            }
            else
            {
                report.AppendLine($"- (警告) {TriggerName} の ScriptableItem または {TriggerScriptPath} が無いのでスキップ");
            }

            // 3. PlaneBody: ScriptableItem を JS アセットに差し替え
            var planeBody = FindInScene(scene, PlaneBodyName);
            var planeItem = planeBody != null ? planeBody.GetComponent<ScriptableItem>() : null;
            if (planeItem != null && planeJs != null)
            {
                SetSourceCodeAsset(planeItem, planeJs);
                report.AppendLine($"- {PlaneBodyName} の ScriptableItem → {PlaneBodyScriptPath}");
                if (EnsureWorldItemReference(trigger, PlaneBodyName, planeBody.GetComponent<Item>()))
                {
                    report.AppendLine($"- {TriggerName} の WorldItemReferenceList に {PlaneBodyName} を追加");
                }
            }
            else
            {
                report.AppendLine($"- (警告) {PlaneBodyName} の ScriptableItem が見つからないのでスキップ");
            }

            // 4. ControlPanel: ScriptableItem を JS アセットに差し替え、PlayerScript から参照できるようにする
            var panel = FindInScene(scene, ControlPanelName);
            var panelItem = panel != null ? panel.GetComponent<ScriptableItem>() : null;
            if (panelItem != null && panelJs != null)
            {
                SetSourceCodeAsset(panelItem, panelJs);
                report.AppendLine($"- {ControlPanelName} の ScriptableItem → {ControlPanelScriptPath}");
                if (EnsureWorldItemReference(trigger, ControlPanelName, panel.GetComponent<Item>()))
                {
                    report.AppendLine($"- {TriggerName} の WorldItemReferenceList に {ControlPanelName} を追加");
                }
            }
            else
            {
                report.AppendLine($"- (警告) {ControlPanelName} の ScriptableItem または {ControlPanelScriptPath} が無いのでスキップ (OSC 送信は無効)");
            }

            Undo.CollapseUndoOperations(undoGroup);
            EditorSceneManager.MarkSceneDirty(scene);
            Selection.activeGameObject = monitor;
            EditorGUIUtility.PingObject(monitor);
            return true;
        }

        static void Fail(string message)
        {
            Debug.LogError($"[OSC Flight] {message}");
            EditorUtility.DisplayDialog("OSC Flight Monitor", message, "OK");
        }

        internal static GameObject FindInScene(Scene scene, string name)
        {
            return scene.GetRootGameObjects()
                .SelectMany(root => root.GetComponentsInChildren<Transform>(true))
                .Select(t => t.gameObject)
                .FirstOrDefault(g => g.name == name);
        }

        internal static void SetSourceCodeAsset(Component component, JavaScriptAsset asset)
        {
            var so = new SerializedObject(component);
            so.FindProperty("sourceCodeAsset").objectReferenceValue = asset;
            // 埋め込みコードは使われなくなるので消しておく (旧コードは git 履歴に残っている)
            so.FindProperty("sourceCode").stringValue = "";
            so.ApplyModifiedProperties();
        }

        static void SetPlayerLocalReferences(GameObject trigger, Dictionary<string, GameObject> refs)
        {
            var list = trigger.GetComponent<PlayerLocalObjectReferenceList>();
            if (list == null)
            {
                list = Undo.AddComponent<PlayerLocalObjectReferenceList>(trigger);
            }
            var so = new SerializedObject(list);
            var entries = so.FindProperty("playerLocalObjectReferences");
            for (var i = entries.arraySize - 1; i >= 0; i--)
            {
                var id = entries.GetArrayElementAtIndex(i).FindPropertyRelative("id").stringValue ?? "";
                if (id.StartsWith(IdPrefix))
                {
                    entries.DeleteArrayElementAtIndex(i);
                }
            }
            foreach (var pair in refs.OrderBy(p => p.Key))
            {
                entries.arraySize++;
                var entry = entries.GetArrayElementAtIndex(entries.arraySize - 1);
                entry.FindPropertyRelative("id").stringValue = pair.Key;
                entry.FindPropertyRelative("targetObject").objectReferenceValue = pair.Value;
            }
            so.ApplyModifiedProperties();
        }

        internal static bool EnsureWorldItemReference(GameObject trigger, string id, Item item)
        {
            if (item == null)
            {
                return false;
            }
            var list = trigger.GetComponent<WorldItemReferenceList>();
            if (list == null)
            {
                list = Undo.AddComponent<WorldItemReferenceList>(trigger);
            }
            var so = new SerializedObject(list);
            var entries = so.FindProperty("worldItemReferences");
            for (var i = 0; i < entries.arraySize; i++)
            {
                var entry = entries.GetArrayElementAtIndex(i);
                if (entry.FindPropertyRelative("id").stringValue == id &&
                    entry.FindPropertyRelative("item").objectReferenceValue != null)
                {
                    return false;
                }
            }
            entries.arraySize++;
            var added = entries.GetArrayElementAtIndex(entries.arraySize - 1);
            added.FindPropertyRelative("id").stringValue = id;
            added.FindPropertyRelative("item").objectReferenceValue = item;
            so.ApplyModifiedProperties();
            return true;
        }

        // ------------------------------------------------------------------
        // UI 生成
        // ------------------------------------------------------------------

        static GameObject BuildMonitor(Dictionary<string, GameObject> refs)
        {
            var root = new GameObject(MonitorName, typeof(RectTransform));
            root.AddComponent<PlayerLocalUI>(); // Canvas と CanvasScaler も追加される
            var canvas = root.GetComponent<Canvas>();
            canvas.renderMode = RenderMode.WorldSpace;
            // ScreenSpace 用の SafeArea が自動生成されるが、ワールド空間では不要
            foreach (var safeArea in root.GetComponentsInChildren<SafeArea>(true))
            {
                Object.DestroyImmediate(safeArea.gameObject);
            }

            var rootRt = (RectTransform) root.transform;
            rootRt.pivot = new Vector2(0.5f, 0.5f);
            rootRt.sizeDelta = new Vector2(BoardWidth, BoardHeight);
            rootRt.localScale = Vector3.one * CanvasScale;

            var background = CreateRect("Background", rootRt, 0, 0, BoardWidth, BoardHeight);
            AddImage(background, BoardColor);

            CreateText(rootRt, "Title", 24, 4, 520, 40, 30, "<b>OSC FLIGHT MONITOR</b>", TextAlignmentOptions.MidlineLeft);
            refs[IdPrefix + "tx"] = CreateText(rootRt, "Tx", 24, 44, 640, 32, 18,
                "<color=#8c8c94>TX -</color>", TextAlignmentOptions.MidlineLeft).gameObject;
            refs[IdPrefix + "status"] = CreateText(rootRt, "Status", 680, 8, 896, 32, 20,
                "<color=#8c8c94>stopped - click Cube_OSC_Trigger to start monitoring</color>",
                TextAlignmentOptions.MidlineRight).gameObject;
            refs[IdPrefix + "operator"] = CreateText(rootRt, "Operator", 680, 42, 896, 32, 20,
                "", TextAlignmentOptions.MidlineRight).gameObject;

            BuildCard(rootRt, refs, "att", "ATTITUDE", "/plane/data", 20, 80);
            BuildCard(rootRt, refs, "ail", "AILERON", "/plane/aileron/quat", 610, 80);
            BuildCard(rootRt, refs, "elv", "ELEVATOR", "/plane/elevator/quat", 20, 490);
            BuildCard(rootRt, refs, "rud", "RUDDER", "/plane/rudder/quat", 610, 490);
            BuildCard(rootRt, refs, "pos", "POSITION", "/plane/pos", 20, 900);
            BuildTrackPanel(rootRt, refs, 610, 900);

            // 舵面プレビュー
            var previewPanel = CreateRect("PreviewPanel", rootRt, 1200, 80, 380, 440);
            AddImage(previewPanel, CardColor);
            CreateText(previewPanel, "Title", 14, 6, 352, 32, 24, "<b>SURFACE PREVIEW</b>  <size=65%><color=#8f97a3>+ attitude</color></size>", TextAlignmentOptions.MidlineLeft);
            CreateText(previewPanel, "Legend", 14, 380, 352, 56, 15,
                "<color=#ffa633>AIL L/R</color>  <color=#33d9ff>ELV</color>  <color=#ff66cc>RUD</color>   <color=#8c8c94>gray = neutral</color>\n" +
                "<color=#ff5959>X</color> <color=#59ff73>Y</color> <color=#5999ff>Z</color> <color=#8c8c94>= plane local axes (Z forward)</color>",
                TextAlignmentOptions.TopLeft);
            var preview = new GameObject("Preview", typeof(RectTransform));
            var previewRt = (RectTransform) preview.transform;
            previewRt.SetParent(previewPanel, false);
            previewRt.anchorMin = previewRt.anchorMax = new Vector2(0.5f, 0.5f);
            previewRt.pivot = new Vector2(0.5f, 0.5f);
            previewRt.sizeDelta = Vector2.zero;
            previewRt.anchoredPosition3D = new Vector3(0f, 10f, PreviewZ);
            previewRt.localRotation = Quaternion.Euler(PreviewEuler);
            previewRt.localScale = Vector3.one / CanvasScale; // ローカル座標を m 単位にする
            refs[IdPrefix + "preview"] = preview;

            // イベントログ
            var logPanel = CreateRect("LogPanel", rootRt, 1200, 530, 380, 760);
            AddImage(logPanel, CardColor);
            CreateText(logPanel, "Title", 14, 6, 352, 32, 24, "<b>EVENTS</b>", TextAlignmentOptions.MidlineLeft);
            refs[IdPrefix + "log"] = CreateText(logPanel, "Log", 14, 42, 352, 708, 15, "<color=#8c8c94>no events</color>",
                TextAlignmentOptions.TopLeft, true).gameObject;

            return root;
        }

        // Cube_OSC_Trigger の上に浮かぶ操縦者名 (TextMeshPro)。OscTrigger.js が書き換え、全員に同期される
        static void BuildOperatorLabel(GameObject trigger)
        {
            var old = trigger.transform.Find(OperatorLabelName);
            if (old != null)
            {
                Undo.DestroyObjectImmediate(old.gameObject);
            }

            var go = new GameObject(OperatorLabelName, typeof(RectTransform));
            Undo.RegisterCreatedObjectUndo(go, "Create Operator Label");
            var rt = (RectTransform) go.transform;
            rt.SetParent(trigger.transform, false);

            // 位置はトリガーの真上。向きはスポーン地点 (原点) から読める向き、大きさは親のスケールに依存させない
            var worldPos = trigger.transform.position + Vector3.up * OperatorLabelHeight;
            var view = worldPos - Vector3.zero;
            view.y = 0f;
            var worldRot = view.sqrMagnitude > 1e-4f ? Quaternion.LookRotation(view) : Quaternion.identity;
            rt.SetPositionAndRotation(worldPos, worldRot);
            var parentScale = trigger.transform.lossyScale;
            rt.localScale = new Vector3(1f / Mathf.Max(1e-4f, Mathf.Abs(parentScale.x)),
                1f / Mathf.Max(1e-4f, Mathf.Abs(parentScale.y)),
                1f / Mathf.Max(1e-4f, Mathf.Abs(parentScale.z)));
            rt.sizeDelta = new Vector2(2.4f, 0.6f);

            var tmp = go.AddComponent<TextMeshPro>();
            tmp.richText = true;
            tmp.text = "<size=55%><color=#8c8c94>OSC OPERATOR</color></size>\n<color=#8c8c94>none - click to take control</color>";
            tmp.fontSize = 2.2f;
            tmp.color = TextColor;
            tmp.alignment = TextAlignmentOptions.Bottom;
            tmp.textWrappingMode = TextWrappingModes.NoWrap;
            tmp.overflowMode = TextOverflowModes.Overflow;
        }

        // 上から見た機体の軌跡。Plot ノード (m 単位) に OscFlightPlayer.js がポリラインを描く
        static void BuildTrackPanel(RectTransform parent, Dictionary<string, GameObject> refs, float x, float y)
        {
            const float width = 570f;
            const float height = 390f;
            var panel = CreateRect("TrackPanel", parent, x, y, width, height);
            AddImage(panel, CardColor);
            CreateText(panel, "Title", 14, 6, width - 28, 32, 26,
                "<b>TRACK</b>  <size=70%><color=#8f97a3>top view of the room</color></size>", TextAlignmentOptions.MidlineLeft);
            var info = CreateText(panel, "Info", 14, 38, width - 28, 26, 16, "<color=#8c8c94>waiting for /plane/pos</color>",
                TextAlignmentOptions.MidlineLeft);

            const float graphX = 14f, graphY = 68f, graphW = width - 28f, graphH = 290f, pad = 8f;
            var graph = CreateRect("Graph", panel, graphX, graphY, graphW, graphH);
            AddImage(graph, GraphColor);
            var plot = new GameObject("Plot", typeof(RectTransform));
            var plotRt = (RectTransform) plot.transform;
            plotRt.SetParent(graph, false);
            plotRt.anchorMin = plotRt.anchorMax = Vector2.zero;
            plotRt.pivot = Vector2.zero;
            plotRt.localScale = Vector3.one / CanvasScale;
            plotRt.sizeDelta = new Vector2((graphW - pad * 2) * CanvasScale, (graphH - pad * 2) * CanvasScale);
            plotRt.anchoredPosition3D = new Vector3(pad, pad, PlotZ);

            CreateText(panel, "Legend", 14, 362, width - 28, 24, 15,
                "<color=#ffd24d>trail</color>  <color=#ffffff>plane (nose = yaw)</color>  <color=#8c8c94>+ = start position   frame = movable range</color>",
                TextAlignmentOptions.MidlineLeft);

            refs[$"{IdPrefix}track.info"] = info.gameObject;
            refs[$"{IdPrefix}track.plot"] = plot;
        }

        static void BuildCard(RectTransform parent, Dictionary<string, GameObject> refs,
            string key, string title, string address, float x, float y)
        {
            const float width = 570f;
            const float height = 390f;
            var card = CreateRect($"Card_{key}", parent, x, y, width, height);
            AddImage(card, CardColor);

            CreateText(card, "Title", 14, 6, width - 28, 32, 26,
                $"<b>{title}</b>  <size=70%><color=#8f97a3>{address}</color></size>", TextAlignmentOptions.MidlineLeft);
            var info = CreateText(card, "Info", 14, 38, width - 28, 26, 18, "<color=#8c8c94>WAITING</color>",
                TextAlignmentOptions.MidlineLeft);

            const float graphX = 14f, graphY = 68f, graphW = width - 28f, graphH = 200f, pad = 8f;
            var graph = CreateRect("Graph", card, graphX, graphY, graphW, graphH);
            AddImage(graph, GraphColor);

            // ポリライン描画用ノード。lossyScale = 1 にして、ローカル座標 / 線幅を m 単位にする。
            // sizeDelta (= m) を PlayerScript が読んでグラフの大きさに使う。原点は左下。
            var plot = new GameObject("Plot", typeof(RectTransform));
            var plotRt = (RectTransform) plot.transform;
            plotRt.SetParent(graph, false);
            plotRt.anchorMin = plotRt.anchorMax = Vector2.zero;
            plotRt.pivot = Vector2.zero;
            plotRt.localScale = Vector3.one / CanvasScale;
            plotRt.sizeDelta = new Vector2((graphW - pad * 2) * CanvasScale, (graphH - pad * 2) * CanvasScale);
            plotRt.anchoredPosition3D = new Vector3(pad, pad, PlotZ);

            var range = CreateText(card, "Range", 14, 272, width - 28, 26, 16, "", TextAlignmentOptions.MidlineLeft);
            var values = CreateText(card, "Values", 14, 302, width - 28, 84, 17, "<color=#8c8c94>no data</color>",
                TextAlignmentOptions.TopLeft);

            refs[$"{IdPrefix}{key}.info"] = info.gameObject;
            refs[$"{IdPrefix}{key}.plot"] = plot;
            refs[$"{IdPrefix}{key}.range"] = range.gameObject;
            refs[$"{IdPrefix}{key}.values"] = values.gameObject;
        }

        // 親の左上を原点とした px 座標で RectTransform を作る
        static RectTransform CreateRect(string name, RectTransform parent, float x, float y, float w, float h)
        {
            var go = new GameObject(name, typeof(RectTransform));
            var rt = (RectTransform) go.transform;
            rt.SetParent(parent, false);
            rt.anchorMin = rt.anchorMax = new Vector2(0f, 1f);
            rt.pivot = new Vector2(0f, 1f);
            rt.anchoredPosition = new Vector2(x, -y);
            rt.sizeDelta = new Vector2(w, h);
            return rt;
        }

        static Image AddImage(RectTransform rt, Color color)
        {
            var image = rt.gameObject.AddComponent<Image>();
            image.color = color;
            image.raycastTarget = false;
            return image;
        }

        static TextMeshProUGUI CreateText(RectTransform parent, string name, float x, float y, float w, float h,
            float fontSize, string text, TextAlignmentOptions alignment, bool wrap = false)
        {
            var rt = CreateRect(name, parent, x, y, w, h);
            var tmp = rt.gameObject.AddComponent<TextMeshProUGUI>();
            tmp.richText = true;
            tmp.text = text;
            tmp.fontSize = fontSize;
            tmp.color = TextColor;
            tmp.alignment = alignment;
            tmp.textWrappingMode = wrap ? TextWrappingModes.Normal : TextWrappingModes.NoWrap;
            tmp.overflowMode = wrap ? TextOverflowModes.Truncate : TextOverflowModes.Overflow;
            tmp.raycastTarget = false;
            return tmp;
        }
    }
}
