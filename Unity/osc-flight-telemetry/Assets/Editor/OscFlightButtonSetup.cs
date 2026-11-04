using System.Linq;
using ClusterVR.CreatorKit.Item.Implements;
using TMPro;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace OscFlightTelemetry.EditorTools
{
    /// <summary>
    /// Cube_OSC_Trigger の見た目を「OSC 受信を始める押しボタン」にする。
    ///   - 元の Cube のメッシュを外し、台座 (Pedestal) / ベゼル (Bezel) / 押しボタン (Cap) / 前面ラベル (FrontLabel) を子に作る
    ///   - Cap は OscTrigger.js がクリック時に沈ませる (名前で $.subNode から参照するので変えないこと)
    ///   - 当たり判定 (BoxCollider) をボタン全体の大きさに合わせる
    /// 何度実行しても同じ状態になる。初回だけ、前面がスポーン地点 (原点) を向くように回す。
    /// Item / ScriptableItem / PlayerScript などのコンポーネントと OperatorLabel には触らない。
    /// </summary>
    public static class OscFlightButtonSetup
    {
        const string MenuPath = "Tools/OSC Flight/Setup Start Button In Open Scene";
        const string TriggerName = "Cube_OSC_Trigger";
        const string MaterialFolder = "Assets/Materials";

        const string PedestalName = "Pedestal";
        const string BezelName = "Bezel";
        const string CapName = "Cap";
        const string FrontLabelName = "FrontLabel";
        static readonly string[] PartNames = { PedestalName, BezelName, CapName, FrontLabelName };

        // 寸法 (m, トリガーのローカル座標)。元の 1m Cube の底面 (y = -0.5) を床とみなす
        const float FloorY = -0.5f;
        const float PedestalWidth = 0.42f;
        const float PedestalHeight = 0.85f;
        const float BezelDiameter = 0.34f;
        const float BezelHeight = 0.03f;
        const float CapDiameter = 0.26f;
        const float CapHeight = 0.06f;

        static readonly Color BodyColor = new Color(0.17f, 0.18f, 0.21f, 1f);
        static readonly Color BezelColor = new Color(0.07f, 0.07f, 0.08f, 1f);
        static readonly Color CapColor = new Color(0.2f, 0.85f, 0.35f, 1f);
        static readonly Color CapEmission = new Color(0.12f, 0.75f, 0.25f, 1f) * 1.4f;

        [MenuItem(MenuPath)]
        public static void Setup()
        {
            var scene = SceneManager.GetActiveScene();
            if (!scene.IsValid() || !scene.isLoaded)
            {
                Fail("シーンが開かれていません。");
                return;
            }

            var trigger = scene.GetRootGameObjects()
                .SelectMany(root => root.GetComponentsInChildren<Transform>(true))
                .Select(t => t.gameObject)
                .FirstOrDefault(g => g.name == TriggerName && g.GetComponent<PlayerScript>() != null);
            if (trigger == null)
            {
                Fail($"PlayerScript を持つ '{TriggerName}' がシーンに見つかりません。");
                return;
            }

            var bodyMat = EnsureMaterial("OscButton_Body", BodyColor, 0.1f, 0.45f, null);
            var bezelMat = EnsureMaterial("OscButton_Bezel", BezelColor, 0.6f, 0.7f, null);
            var capMat = EnsureMaterial("OscButton_Cap", CapColor, 0f, 0.6f, CapEmission);

            Undo.SetCurrentGroupName("Setup OSC Start Button");
            var undoGroup = Undo.GetCurrentGroup();
            var root = trigger.transform;
            var firstTime = root.Find(CapName) == null;

            // 1. 元の Cube の見た目を外す (当たり判定は BoxCollider を流用する)
            var renderer = trigger.GetComponent<MeshRenderer>();
            if (renderer != null) Undo.DestroyObjectImmediate(renderer);
            var filter = trigger.GetComponent<MeshFilter>();
            if (filter != null) Undo.DestroyObjectImmediate(filter);

            // 2. 前回作った部品を消す
            foreach (var name in PartNames)
            {
                var old = root.Find(name);
                if (old != null) Undo.DestroyObjectImmediate(old.gameObject);
            }

            // 3. 初回だけ前面 (+Z) をスポーン地点に向ける。ほかの子 (OperatorLabel など) のワールド姿勢は保つ
            if (firstTime)
            {
                var toSpawn = Vector3.zero - root.position;
                toSpawn.y = 0f;
                if (toSpawn.sqrMagnitude > 1e-4f)
                {
                    var children = Enumerable.Range(0, root.childCount).Select(root.GetChild).ToArray();
                    var poses = children.Select(c => (c.position, c.rotation)).ToArray();
                    Undo.RecordObject(root, "Rotate OSC Start Button");
                    foreach (var c in children) Undo.RecordObject(c, "Rotate OSC Start Button");
                    root.rotation = Quaternion.LookRotation(toSpawn);
                    for (var i = 0; i < children.Length; i++)
                    {
                        children[i].SetPositionAndRotation(poses[i].position, poses[i].rotation);
                    }
                }
            }

            // 4. 部品を作る (Unity の Cylinder は高さ 2 なので y スケールは高さの半分)
            var topY = FloorY + PedestalHeight;
            CreatePart(PrimitiveType.Cube, PedestalName, root, bodyMat,
                new Vector3(0f, FloorY + PedestalHeight / 2f, 0f),
                new Vector3(PedestalWidth, PedestalHeight, PedestalWidth));
            CreatePart(PrimitiveType.Cylinder, BezelName, root, bezelMat,
                new Vector3(0f, topY + BezelHeight / 2f, 0f),
                new Vector3(BezelDiameter, BezelHeight / 2f, BezelDiameter));
            CreatePart(PrimitiveType.Cylinder, CapName, root, capMat,
                new Vector3(0f, topY + BezelHeight + CapHeight / 2f, 0f),
                new Vector3(CapDiameter, CapHeight / 2f, CapDiameter));
            CreateFrontLabel(root, topY);

            // 5. 当たり判定をボタン全体に合わせる
            var collider = trigger.GetComponent<BoxCollider>();
            if (collider == null) collider = Undo.AddComponent<BoxCollider>(trigger);
            Undo.RecordObject(collider, "Resize OSC Start Button Collider");
            var totalHeight = PedestalHeight + BezelHeight + CapHeight;
            collider.center = new Vector3(0f, FloorY + totalHeight / 2f, 0f);
            collider.size = new Vector3(PedestalWidth, totalHeight, PedestalWidth);

            Undo.CollapseUndoOperations(undoGroup);
            EditorSceneManager.MarkSceneDirty(scene);
            Selection.activeGameObject = trigger;
            EditorGUIUtility.PingObject(trigger);

            var message = $"- {TriggerName} を押しボタンの見た目にしました ({string.Join(" / ", PartNames)})\n" +
                          (firstTime ? "- 前面をスポーン地点 (原点) に向けました\n" : "") +
                          $"- マテリアル: {MaterialFolder}/OscButton_*.mat\n" +
                          "- 押し込みアニメーションには OscTrigger.js が必要です (Setup Monitor In Open Scene で設定)";
            Debug.Log($"[OSC Flight] ボタンのセットアップ完了\n{message}");
            EditorUtility.DisplayDialog("OSC Start Button",
                $"セットアップしました。シーンを保存してください (Ctrl+S)。\n\n{message}", "OK");
        }

        static void Fail(string message)
        {
            Debug.LogError($"[OSC Flight] {message}");
            EditorUtility.DisplayDialog("OSC Start Button", message, "OK");
        }

        static void CreatePart(PrimitiveType type, string name, Transform parent, Material material,
            Vector3 localPosition, Vector3 localScale)
        {
            var go = GameObject.CreatePrimitive(type);
            go.name = name;
            // 当たり判定は親の BoxCollider だけにする
            Object.DestroyImmediate(go.GetComponent<Collider>());
            go.GetComponent<MeshRenderer>().sharedMaterial = material;
            go.transform.SetParent(parent, false);
            go.transform.localPosition = localPosition;
            go.transform.localRotation = Quaternion.identity;
            go.transform.localScale = localScale;
            Undo.RegisterCreatedObjectUndo(go, $"Create {name}");
        }

        // 台座の前面 (+Z) に貼る静的なラベル
        static void CreateFrontLabel(Transform parent, float topY)
        {
            var go = new GameObject(FrontLabelName, typeof(RectTransform));
            var rt = (RectTransform) go.transform;
            rt.SetParent(parent, false);
            rt.localPosition = new Vector3(0f, topY - 0.2f, PedestalWidth / 2f + 0.002f);
            rt.localRotation = Quaternion.Euler(0f, 180f, 0f); // TextMeshPro は -Z 側から読めるので裏返す
            rt.localScale = Vector3.one;
            rt.sizeDelta = new Vector2(PedestalWidth - 0.04f, 0.3f);

            var tmp = go.AddComponent<TextMeshPro>();
            tmp.richText = true;
            tmp.text = "<b><color=#59ff73>OSC</color></b>\n<size=42%>PUSH TO RECEIVE</size>";
            tmp.enableAutoSizing = true;
            tmp.fontSizeMin = 0.2f;
            tmp.fontSizeMax = 1.4f;
            tmp.color = new Color(0.9f, 0.92f, 0.95f, 1f);
            tmp.alignment = TextAlignmentOptions.Center;
            tmp.textWrappingMode = TextWrappingModes.NoWrap;
            Undo.RegisterCreatedObjectUndo(go, $"Create {FrontLabelName}");
        }

        // Built-in の Standard シェーダーでマテリアルを作る (あれば値を更新する)
        static Material EnsureMaterial(string name, Color color, float metallic, float smoothness, Color? emission)
        {
            var path = $"{MaterialFolder}/{name}.mat";
            var mat = AssetDatabase.LoadAssetAtPath<Material>(path);
            if (mat == null)
            {
                if (!AssetDatabase.IsValidFolder(MaterialFolder)) AssetDatabase.CreateFolder("Assets", "Materials");
                mat = new Material(Shader.Find("Standard")) { name = name };
                AssetDatabase.CreateAsset(mat, path);
            }
            mat.color = color;
            mat.SetFloat("_Metallic", metallic);
            mat.SetFloat("_Glossiness", smoothness);
            if (emission.HasValue)
            {
                mat.EnableKeyword("_EMISSION");
                mat.SetColor("_EmissionColor", emission.Value);
            }
            else
            {
                mat.DisableKeyword("_EMISSION");
                mat.SetColor("_EmissionColor", Color.black);
            }
            // ライトベイクに影響させない
            mat.globalIlluminationFlags = MaterialGlobalIlluminationFlags.EmissiveIsBlack;
            EditorUtility.SetDirty(mat);
            AssetDatabase.SaveAssetIfDirty(mat);
            return mat;
        }
    }
}
