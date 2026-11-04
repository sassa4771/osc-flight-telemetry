using System.Collections.Generic;
using System.Linq;
using System.Text;
using ClusterVR.CreatorKit.Item.Implements;
using TMPro;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace OscFlightTelemetry.EditorTools
{
    /// <summary>
    /// ControlPanel を OSC モニターと同じ見た目 (ボード / カード) で作り直す。
    ///   上段: トリム角 (AILERON / ELEVATOR / RUDDER)。数値・-30..+30 のゲージ・-10 / -1 / 0 / +1 / +10 ボタン
    ///   下段: PID ゲイン (ROLL / PITCH / YAW)。Kp / Ki / Kd ごとに数値と -1 / -0.1 / -0.01 / +0.01 / +0.1 / +1 ボタン
    ///   ヘッダー: 送信状態と RESET TRIM ボタン
    /// 詳細
    ///   - ControlPanel の子はすべて作り直す (位置は維持。向きは初回だけスポーン地点 (原点) 側に向ける)
    ///   - 旧ボタン (ControlPanel を参照している Scriptable Item, Btn_*) は削除する
    ///   - ボタンは Item の中に Item を入れられないので、シーン直下の ControlPanelButtons にまとめる
    ///   - スクリプト: ControlPanel → ControlPanel.js, 各ボタン → ControlButton.js (共通)。
    ///     どのボタンかは ControlPanel の WorldItemReferenceList (btn.*) で判別する (id は ControlPanel.js 参照)
    ///   - Cube_OSC_Trigger の WorldItemReferenceList に ControlPanel を登録する (OSC 送信用)
    /// 何度実行しても同じ状態になる。パネルを動かしたら再実行するとボタンも追従する。
    /// </summary>
    public static class OscFlightControlPanelSetup
    {
        const string MenuPath = "Tools/OSC Flight/Setup Control Panel In Open Scene";
        const string SetupAllMenuPath = "Tools/OSC Flight/Setup All In Open Scene";
        const string PanelName = "ControlPanel";
        const string TriggerName = "Cube_OSC_Trigger";
        const string ButtonsRootName = "ControlPanelButtons";
        const string BoardName = "Board";
        const string PanelScriptPath = "Assets/Scripts/OscFlight/ControlPanel.js";
        const string ButtonScriptPath = "Assets/Scripts/OscFlight/ControlButton.js";
        const string MaterialFolder = "Assets/Materials";
        const string RefPrefix = "btn.";

        // ---- 寸法 (m)。レイアウト座標は「ボード左上が原点、x 右 / y 下」。z はマイナスが手前 (見る人の側)
        const float Margin = 0.03f;
        const float CardW = 0.68f;
        const float HeaderH = 0.16f;
        const float TrimCardH = 0.52f;
        const float PidCardH = 0.48f;
        const float TrimY0 = HeaderH;
        const float PidY0 = TrimY0 + TrimCardH + Margin;
        const float BoardW = CardW * 3 + Margin * 4;
        const float BoardH = PidY0 + PidCardH + Margin;
        const float BoardDepth = 0.04f;
        const float KeyDepth = 0.03f;
        const float TrimMin = -30f;
        const float TrimMax = 30f;

        // ---- 色 (OscFlightMonitorSetup / OscFlightPlayer.js と同じ)
        static readonly Color BoardColor = new Color(0.06f, 0.07f, 0.09f, 1f);
        static readonly Color CardColor = new Color(0.11f, 0.12f, 0.15f, 1f);
        static readonly Color GraphColor = new Color(0.03f, 0.035f, 0.045f, 1f);
        static readonly Color GridColor = new Color(0.28f, 0.3f, 0.35f, 1f);
        static readonly Color GridMidColor = new Color(0.5f, 0.52f, 0.58f, 1f);
        static readonly Color KeyColor = new Color(0.19f, 0.21f, 0.26f, 1f);
        static readonly Color KeyResetColor = new Color(0.32f, 0.11f, 0.12f, 1f);
        static readonly Color TextColor = new Color(0.9f, 0.92f, 0.95f, 1f);
        static readonly Color PidAccent = new Color(0.35f, 1f, 0.45f, 1f); // #59ff73

        struct Trim
        {
            public string Axis;    // ControlPanel.js の axis 名
            public string Title;
            public Color Accent;
            public string AccentHex;
        }

        static readonly Trim[] Trims =
        {
            new Trim { Axis = "aileron", Title = "AILERON TRIM", Accent = new Color(1f, 0.65f, 0.2f), AccentHex = "#ffa633" },
            new Trim { Axis = "elevator", Title = "ELEVATOR TRIM", Accent = new Color(0.2f, 0.85f, 1f), AccentHex = "#33d9ff" },
            new Trim { Axis = "rudder", Title = "RUDDER TRIM", Accent = new Color(1f, 0.4f, 0.8f), AccentHex = "#ff66cc" },
        };

        static readonly string[] PidAxes = { "roll", "pitch", "yaw" };
        static readonly (string key, string label)[] PidParams = { ("kp", "Kp"), ("ki", "Ki"), ("kd", "Kd") };

        // ControlPanel.js の TRIM_STEPS / GAIN_STEPS と同じキー
        static readonly (string key, string label)[] TrimSteps =
        {
            ("m10", "-10"), ("m1", "-1"), ("zero", "0"), ("p1", "+1"), ("p10", "+10"),
        };
        static readonly (string key, string label)[] GainSteps =
        {
            ("m1", "-1"), ("m01", "-.1"), ("m001", "-.01"), ("p001", "+.01"), ("p01", "+.1"), ("p1", "+1"),
        };

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
            Done("OSC Control Panel", report.ToString());
        }

        [MenuItem(SetupAllMenuPath, priority = 0)]
        public static void SetupAll()
        {
            var scene = SceneManager.GetActiveScene();
            var report = new StringBuilder();
            report.AppendLine("[Monitor]");
            if (!OscFlightMonitorSetup.Run(scene, report, out var error))
            {
                Fail(error);
                return;
            }
            report.AppendLine().AppendLine("[Control Panel]");
            if (!Run(scene, report, out error))
            {
                Fail($"モニターはセットアップしましたが、ControlPanel で失敗しました: {error}");
                return;
            }
            Done("OSC Flight", report.ToString());
        }

        static void Done(string title, string message)
        {
            Debug.Log($"[OSC Flight] セットアップ完了\n{message}");
            EditorUtility.DisplayDialog(title, $"セットアップしました。シーンを保存してください (Ctrl+S)。\n\n{message}", "OK");
        }

        static void Fail(string message)
        {
            Debug.LogError($"[OSC Flight] {message}");
            EditorUtility.DisplayDialog("OSC Flight", message, "OK");
        }

        internal static bool Run(Scene scene, StringBuilder report, out string error)
        {
            error = null;
            if (!scene.IsValid() || !scene.isLoaded)
            {
                error = "シーンが開かれていません。";
                return false;
            }
            var panel = scene.GetRootGameObjects()
                .SelectMany(root => root.GetComponentsInChildren<ScriptableItem>(true))
                .Select(c => c.gameObject)
                .FirstOrDefault(g => g.name == PanelName);
            if (panel == null)
            {
                error = $"ScriptableItem を持つ '{PanelName}' がシーンに見つかりません。";
                return false;
            }
            var panelItem = panel.GetComponent<Item>();

            AssetDatabase.ImportAsset(PanelScriptPath);
            AssetDatabase.ImportAsset(ButtonScriptPath);
            var panelJs = AssetDatabase.LoadAssetAtPath<JavaScriptAsset>(PanelScriptPath);
            var buttonJs = AssetDatabase.LoadAssetAtPath<JavaScriptAsset>(ButtonScriptPath);
            if (panelJs == null || buttonJs == null)
            {
                error = $"{PanelScriptPath} / {ButtonScriptPath} を JavaScriptAsset として読み込めません。";
                return false;
            }

            Undo.SetCurrentGroupName("Setup OSC Control Panel");
            var undoGroup = Undo.GetCurrentGroup();
            var mats = new Materials();

            // 1. 向き: 初回だけ、表 (ローカル -Z 側) をスポーン地点 (原点) に向ける (水平、90 度単位)
            var root = panel.transform;
            if (root.Find(BoardName) == null)
            {
                var toSpawn = Vector3.zero - root.position;
                toSpawn.y = 0f;
                if (toSpawn.sqrMagnitude > 1e-4f)
                {
                    var front = Mathf.Abs(toSpawn.x) >= Mathf.Abs(toSpawn.z)
                        ? new Vector3(Mathf.Sign(toSpawn.x), 0f, 0f)
                        : new Vector3(0f, 0f, Mathf.Sign(toSpawn.z));
                    Undo.RecordObject(root, "Rotate Control Panel");
                    root.rotation = Quaternion.LookRotation(-front);
                    report.AppendLine($"- {PanelName} の表をスポーン地点側 ({front}) に向けました");
                }
            }
            Undo.RecordObject(root, "Reset Control Panel Scale");
            root.localScale = Vector3.one;

            // 2. 古い子・古いボタンを消す
            for (var i = root.childCount - 1; i >= 0; i--)
            {
                Undo.DestroyObjectImmediate(root.GetChild(i).gameObject);
            }
            var removed = RemoveOldButtons(scene, panelItem);
            if (removed > 0) report.AppendLine($"- 旧ボタンを {removed} 個削除");

            // 3. パネル本体 (ControlPanel の子)
            var board = NewChild(root, BoardName);
            Box(board, "Background", 0f, 0f, BoardW, BoardH, 0f, BoardDepth, mats.Get("Board", BoardColor));
            Text(board, "Title", Margin, 0.02f, 1.4f, 0.07f, -0.004f, 0.65f,
                "<b>CONTROL PANEL</b>  <size=55%><color=#8f97a3>OSC out  /plane/trim  /plane/pid/*</color></size>",
                TextAlignmentOptions.MidlineLeft);
            Text(root, "Status", Margin, 0.09f, BoardW - Margin * 3 - 0.22f, 0.05f, -0.004f, 0.34f,
                "<color=#8c8c94>TX  no operator - click the OSC button to start sending</color>",
                TextAlignmentOptions.MidlineLeft);
            for (var i = 0; i < Trims.Length; i++)
            {
                BuildTrimCard(root, board, mats, Trims[i], CardX(i), TrimY0);
            }
            for (var i = 0; i < PidAxes.Length; i++)
            {
                BuildPidCard(root, board, mats, PidAxes[i], CardX(i), PidY0);
            }
            report.AppendLine($"- {PanelName} の表示を生成 ({BoardW:0.00} m x {BoardH:0.00} m, 位置 {root.position})");

            // 4. ボタン (別アイテム)
            var buttonsRoot = new GameObject(ButtonsRootName);
            Undo.RegisterCreatedObjectUndo(buttonsRoot, "Create Control Panel Buttons");
            SceneManager.MoveGameObjectToScene(buttonsRoot, scene);
            buttonsRoot.transform.SetPositionAndRotation(root.position, root.rotation);
            var parent = buttonsRoot.transform;
            var refs = new Dictionary<string, Item>();
            var keyMat = mats.Get("Key", KeyColor);

            for (var i = 0; i < Trims.Length; i++)
            {
                var t = Trims[i];
                for (var k = 0; k < TrimSteps.Length; k++)
                {
                    var (key, label) = TrimSteps[k];
                    var cx = CardX(i) + CardW / 2f + (k - (TrimSteps.Length - 1) / 2f) * 0.1f;
                    var text = key == "zero" ? $"<b><color={t.AccentHex}>{label}</color></b>" : $"<b>{label}</b>";
                    refs[$"{RefPrefix}{t.Axis}.{key}"] = BuildButton(parent, $"Btn_trim_{t.Axis}_{key}",
                        cx, TrimY0 + 0.44f, 0.088f, 0.07f, keyMat, text, 0.42f, buttonJs, panelItem);
                }
            }
            refs[$"{RefPrefix}reset"] = BuildButton(parent, "Btn_trim_reset", BoardW - Margin - 0.11f, 0.08f, 0.22f, 0.08f,
                mats.Get("KeyReset", KeyResetColor), "<b>RESET TRIM</b>", 0.32f, buttonJs, panelItem);

            for (var i = 0; i < PidAxes.Length; i++)
            {
                var axis = PidAxes[i];
                for (var r = 0; r < PidParams.Length; r++)
                {
                    var param = PidParams[r].key;
                    for (var k = 0; k < GainSteps.Length; k++)
                    {
                        var (key, label) = GainSteps[k];
                        refs[$"{RefPrefix}pid.{axis}.{param}.{key}"] = BuildButton(parent, $"Btn_pid_{axis}_{param}_{key}",
                            CardX(i) + 0.277f + k * 0.072f, PidRowY(r), 0.064f, 0.06f, keyMat, $"<b>{label}</b>", 0.3f,
                            buttonJs, panelItem);
                    }
                }
            }
            report.AppendLine($"- ボタンを {refs.Count} 個生成 ({ButtonsRootName} の下, スクリプト {ButtonScriptPath})");

            // 5. スクリプトと参照
            OscFlightMonitorSetup.SetSourceCodeAsset(panel.GetComponent<ScriptableItem>(), panelJs);
            SetButtonReferences(panel, refs);
            report.AppendLine($"- {PanelName} の ScriptableItem → {PanelScriptPath}、WorldItemReferenceList に {refs.Count} 件登録");

            var trigger = OscFlightMonitorSetup.FindInScene(scene, TriggerName);
            if (trigger != null && trigger.GetComponent<Item>() != null)
            {
                if (OscFlightMonitorSetup.EnsureWorldItemReference(trigger, PanelName, panelItem))
                {
                    report.AppendLine($"- {TriggerName} の WorldItemReferenceList に {PanelName} を追加");
                }
            }
            else
            {
                report.AppendLine($"- (警告) {TriggerName} が無いので OSC 送信の参照を登録できません");
            }

            Undo.CollapseUndoOperations(undoGroup);
            EditorSceneManager.MarkSceneDirty(scene);
            Selection.activeGameObject = panel;
            EditorGUIUtility.PingObject(panel);
            return true;
        }

        static float CardX(int i) => Margin + i * (CardW + Margin);

        static float PidRowY(int r) => PidY0 + 0.135f + r * 0.12f;

        // ControlPanel を参照している Scriptable Item (= 旧ボタン) と、前回生成したボタンを消す
        static int RemoveOldButtons(Scene scene, Item panelItem)
        {
            var targets = new HashSet<GameObject>();
            foreach (var list in scene.GetRootGameObjects().SelectMany(r => r.GetComponentsInChildren<WorldItemReferenceList>(true)))
            {
                if (list.gameObject == panelItem.gameObject || list.GetComponent<ScriptableItem>() == null) continue;
                if (list.GetComponent<PlayerScript>() != null) continue; // Cube_OSC_Trigger など
                var so = new SerializedObject(list);
                var entries = so.FindProperty("worldItemReferences");
                for (var i = 0; i < entries.arraySize; i++)
                {
                    var target = entries.GetArrayElementAtIndex(i).FindPropertyRelative("item").objectReferenceValue;
                    if (target == panelItem && list.gameObject.name.StartsWith("Btn_"))
                    {
                        targets.Add(list.gameObject);
                    }
                }
            }
            var parents = new HashSet<Transform>();
            var count = 0;
            foreach (var go in targets)
            {
                if (go.transform.parent != null) parents.Add(go.transform.parent);
                Undo.DestroyObjectImmediate(go);
                count++;
            }
            var previous = scene.GetRootGameObjects().Where(g => g.name == ButtonsRootName).ToArray();
            foreach (var go in previous)
            {
                count += go.GetComponentsInChildren<ScriptableItem>(true).Length;
                Undo.DestroyObjectImmediate(go);
            }
            // 旧ボタンをまとめていた空の親 (Aileron / Elevator / Rudder) も消す
            foreach (var p in parents)
            {
                if (p != null && p.childCount == 0 && p.GetComponents<Component>().Length == 1)
                {
                    Undo.DestroyObjectImmediate(p.gameObject);
                }
            }
            return count;
        }

        static void SetButtonReferences(GameObject panel, Dictionary<string, Item> refs)
        {
            var list = panel.GetComponent<WorldItemReferenceList>();
            if (list == null) list = Undo.AddComponent<WorldItemReferenceList>(panel);
            var so = new SerializedObject(list);
            var entries = so.FindProperty("worldItemReferences");
            for (var i = entries.arraySize - 1; i >= 0; i--)
            {
                var entry = entries.GetArrayElementAtIndex(i);
                var id = entry.FindPropertyRelative("id").stringValue ?? "";
                // 旧スクリプトが使っていた Cube_OSC_Trigger の参照 (未設定) と前回のボタン参照を消す
                if (id.StartsWith(RefPrefix) || entry.FindPropertyRelative("item").objectReferenceValue == null)
                {
                    entries.DeleteArrayElementAtIndex(i);
                }
            }
            foreach (var pair in refs.OrderBy(p => p.Key))
            {
                entries.arraySize++;
                var entry = entries.GetArrayElementAtIndex(entries.arraySize - 1);
                entry.FindPropertyRelative("id").stringValue = pair.Key;
                entry.FindPropertyRelative("item").objectReferenceValue = pair.Value;
            }
            so.ApplyModifiedProperties();
        }

        // ------------------------------------------------------------------
        // カード
        // ------------------------------------------------------------------

        static void BuildTrimCard(Transform root, Transform board, Materials mats, Trim t, float x0, float y0)
        {
            var card = NewChild(board, $"Card_trim_{t.Axis}");
            var accent = mats.Get($"Accent_{t.Axis}", t.Accent);
            Box(card, "Background", x0, y0, CardW, TrimCardH, -0.003f, 0.003f, mats.Get("Card", CardColor));
            Box(card, "AccentStrip", x0, y0, CardW, 0.008f, -0.005f, 0.002f, accent);

            Text(card, "Title", x0 + 0.025f, y0 + 0.02f, CardW - 0.05f, 0.06f, -0.009f, 0.45f,
                $"<b>{t.Title}</b>  <size=50%><color=#8f97a3>/plane/trim  deg</color></size>", TextAlignmentOptions.MidlineLeft);
            Text(root, $"{t.Axis}_value", x0 + 0.025f, y0 + 0.075f, CardW - 0.05f, 0.13f, -0.009f, 1.0f,
                $"<color={t.AccentHex}>+0.0</color><size=38%><color=#8c8c94> deg</color></size>", TextAlignmentOptions.Center);

            // ゲージ (-30 .. +30)
            Box(card, "GaugeBackground", x0 + 0.025f, y0 + 0.21f, CardW - 0.05f, 0.14f, -0.005f, 0.002f, mats.Get("Graph", GraphColor));
            var trackL = x0 + 0.07f;
            var trackR = x0 + CardW - 0.07f;
            var ty = y0 + 0.26f;
            Box(card, "Track", trackL, ty - 0.004f, trackR - trackL, 0.008f, -0.007f, 0.002f, mats.Get("Grid", GridColor));
            for (var deg = (int) TrimMin; deg <= (int) TrimMax; deg += 10)
            {
                var tx = Mathf.Lerp(trackL, trackR, (deg - TrimMin) / (TrimMax - TrimMin));
                var h = deg == 0 ? 0.05f : 0.03f;
                Box(card, $"Tick{deg}", tx - 0.002f, ty - h / 2f, 0.004f, h, -0.007f, 0.002f,
                    deg == 0 ? mats.Get("GridMid", GridMidColor) : mats.Get("Grid", GridColor));
                Text(card, $"TickLabel{deg}", tx - 0.04f, ty + 0.03f, 0.08f, 0.04f, -0.009f, 0.22f,
                    $"<color=#8c8c94>{(deg > 0 ? "+" : "")}{deg}</color>", TextAlignmentOptions.Center);
            }
            // 針と両端 (ControlPanel.js が両端の位置から針の位置を計算する)
            const float needleZ = -0.008f;
            NewChild(root, $"{t.Axis}_gaugeMin").localPosition = Local(trackL, ty, needleZ);
            NewChild(root, $"{t.Axis}_gaugeMax").localPosition = Local(trackR, ty, needleZ);
            var needle = NewChild(root, $"{t.Axis}_indicator");
            needle.localPosition = Local((trackL + trackR) / 2f, ty, needleZ);
            var needleMesh = Primitive(PrimitiveType.Cube, "Mesh", needle, accent);
            needleMesh.localPosition = Vector3.zero;
            needleMesh.localScale = new Vector3(0.012f, 0.065f, 0.008f);
        }

        static void BuildPidCard(Transform root, Transform board, Materials mats, string axis, float x0, float y0)
        {
            var card = NewChild(board, $"Card_pid_{axis}");
            Box(card, "Background", x0, y0, CardW, PidCardH, -0.003f, 0.003f, mats.Get("Card", CardColor));
            Box(card, "AccentStrip", x0, y0, CardW, 0.008f, -0.005f, 0.002f, mats.Get("Accent_pid", PidAccent));

            var title = axis.ToUpperInvariant();
            Text(card, "Title", x0 + 0.025f, y0 + 0.02f, 0.4f, 0.06f, -0.009f, 0.45f,
                $"<b>{title} PID</b>  <size=50%><color=#8f97a3>/plane/pid/{axis}</color></size>", TextAlignmentOptions.MidlineLeft);
            Text(root, $"pid_{axis}_state", x0 + 0.36f, y0 + 0.02f, CardW - 0.385f, 0.06f, -0.009f, 0.24f,
                "<color=#8c8c94>NOT SENT</color>", TextAlignmentOptions.MidlineRight);

            for (var r = 0; r < PidParams.Length; r++)
            {
                var (param, label) = PidParams[r];
                var cy = PidRowY(r);
                Box(card, $"Row_{param}", x0 + 0.02f, cy - 0.05f, CardW - 0.04f, 0.1f, -0.005f, 0.002f, mats.Get("Graph", GraphColor));
                Text(card, $"Label_{param}", x0 + 0.03f, cy - 0.03f, 0.06f, 0.06f, -0.009f, 0.4f,
                    $"<b>{label}</b>", TextAlignmentOptions.MidlineLeft);
                Text(root, $"pid_{axis}_{param}_value", x0 + 0.09f, cy - 0.035f, 0.15f, 0.07f, -0.009f, 0.5f,
                    "<color=#8c8c94>0.00</color>", TextAlignmentOptions.Center);
            }
            Text(card, "Hint", x0 + 0.025f, y0 + 0.43f, CardW - 0.05f, 0.04f, -0.009f, 0.2f,
                "<color=#8c8c94>0.00 .. 10.00   sent after the first press on this card</color>", TextAlignmentOptions.Center);
        }

        // ------------------------------------------------------------------
        // ボタン (Item + ScriptableItem + WorldItemReferenceList)
        // ------------------------------------------------------------------

        static Item BuildButton(Transform parent, string name, float cx, float cy, float w, float h,
            Material keyMat, string label, float fontSize, JavaScriptAsset script, Item panelItem)
        {
            var go = new GameObject(name);
            Undo.RegisterCreatedObjectUndo(go, $"Create {name}");
            go.transform.SetParent(parent, false);
            // カードの表面 (z = -0.003) に置く。ローカル軸はパネルと同じ (+Z = 奥)
            go.transform.localPosition = Local(cx, cy, -0.003f);
            go.transform.localRotation = Quaternion.identity;

            var collider = go.AddComponent<BoxCollider>();
            collider.center = new Vector3(0f, 0f, -KeyDepth / 2f);
            collider.size = new Vector3(w, h, KeyDepth);

            // Cap = 押し込みで動くノード (ControlButton.js が名前で探す)。メッシュとラベルはその子
            var cap = NewChild(go.transform, "Cap");
            var key = Primitive(PrimitiveType.Cube, "Key", cap, keyMat);
            key.localPosition = new Vector3(0f, 0f, -KeyDepth / 2f);
            key.localScale = new Vector3(w, h, KeyDepth);
            TextAt(cap, "Label", new Vector3(0f, 0f, -KeyDepth - 0.0005f), new Vector2(w, h), fontSize, label,
                TextAlignmentOptions.Center);

            var scriptable = go.AddComponent<ScriptableItem>(); // Item も自動で付く
            OscFlightMonitorSetup.SetSourceCodeAsset(scriptable, script);
            var list = go.AddComponent<WorldItemReferenceList>();
            var so = new SerializedObject(list);
            var entries = so.FindProperty("worldItemReferences");
            entries.arraySize = 1;
            var entry = entries.GetArrayElementAtIndex(0);
            entry.FindPropertyRelative("id").stringValue = PanelName;
            entry.FindPropertyRelative("item").objectReferenceValue = panelItem;
            so.ApplyModifiedProperties();
            return go.GetComponent<Item>();
        }

        // ------------------------------------------------------------------
        // 部品
        // ------------------------------------------------------------------

        // レイアウト座標 (左上原点, y 下向き) -> パネルのローカル座標 (中心原点, y 上向き)
        static Vector3 Local(float x, float y, float z)
        {
            return new Vector3(x - BoardW / 2f, BoardH / 2f - y, z);
        }

        static Transform NewChild(Transform parent, string name)
        {
            var go = new GameObject(name);
            Undo.RegisterCreatedObjectUndo(go, $"Create {name}");
            go.transform.SetParent(parent, false);
            return go.transform;
        }

        static Transform Primitive(PrimitiveType type, string name, Transform parent, Material mat)
        {
            var go = GameObject.CreatePrimitive(type);
            go.name = name;
            Object.DestroyImmediate(go.GetComponent<Collider>()); // 当たり判定はボタンの BoxCollider だけ
            var renderer = go.GetComponent<MeshRenderer>();
            renderer.sharedMaterial = mat;
            renderer.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            renderer.receiveShadows = false;
            go.transform.SetParent(parent, false);
            Undo.RegisterCreatedObjectUndo(go, $"Create {name}");
            return go.transform;
        }

        // 左上 (x, y)・幅 w・高さ h の板。前面が z = front、そこから奥へ depth
        static void Box(Transform parent, string name, float x, float y, float w, float h, float front, float depth, Material mat)
        {
            var t = Primitive(PrimitiveType.Cube, name, parent, mat);
            t.localPosition = Local(x + w / 2f, y + h / 2f, front + depth / 2f);
            t.localScale = new Vector3(w, h, depth);
        }

        static TextMeshPro Text(Transform parent, string name, float x, float y, float w, float h, float z,
            float fontSize, string text, TextAlignmentOptions alignment)
        {
            return TextAt(parent, name, Local(x + w / 2f, y + h / 2f, z), new Vector2(w, h), fontSize, text, alignment);
        }

        static TextMeshPro TextAt(Transform parent, string name, Vector3 localPosition, Vector2 size,
            float fontSize, string text, TextAlignmentOptions alignment)
        {
            var go = new GameObject(name, typeof(RectTransform));
            Undo.RegisterCreatedObjectUndo(go, $"Create {name}");
            var rt = (RectTransform) go.transform;
            rt.SetParent(parent, false);
            rt.localPosition = localPosition;
            rt.localRotation = Quaternion.identity; // TextMeshPro は -Z 側 (手前) から読める
            rt.sizeDelta = size;
            var tmp = go.AddComponent<TextMeshPro>();
            tmp.richText = true;
            tmp.text = text;
            tmp.fontSize = fontSize;
            tmp.color = TextColor;
            tmp.alignment = alignment;
            tmp.textWrappingMode = TextWrappingModes.NoWrap;
            tmp.overflowMode = TextOverflowModes.Overflow;
            return tmp;
        }

        // Unlit/Color のマテリアル (モニターの UI と同じくライティングの影響を受けない)
        class Materials
        {
            readonly Dictionary<string, Material> cache = new Dictionary<string, Material>();

            public Material Get(string name, Color color)
            {
                if (cache.TryGetValue(name, out var cached)) return cached;
                var path = $"{MaterialFolder}/OscPanel_{name}.mat";
                var mat = AssetDatabase.LoadAssetAtPath<Material>(path);
                var shader = Shader.Find("Unlit/Color");
                if (mat == null)
                {
                    if (!AssetDatabase.IsValidFolder(MaterialFolder)) AssetDatabase.CreateFolder("Assets", "Materials");
                    mat = new Material(shader) { name = $"OscPanel_{name}" };
                    AssetDatabase.CreateAsset(mat, path);
                }
                mat.shader = shader;
                mat.color = color;
                EditorUtility.SetDirty(mat);
                AssetDatabase.SaveAssetIfDirty(mat);
                cache[name] = mat;
                return mat;
            }
        }
    }
}
