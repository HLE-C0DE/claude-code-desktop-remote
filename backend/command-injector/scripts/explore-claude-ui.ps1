# Script PowerShell pour explorer l'arborescence UI de Claude Desktop App
# Objectif: Trouver les elements de navigation/sessions

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

# Trouver le processus Claude Desktop
$claudeProc = Get-Process | Where-Object {
    $_.ProcessName -eq 'Claude' -and $_.MainWindowTitle -ne ''
} | Select-Object -First 1

if (-not $claudeProc) {
    Write-Output "ERROR: Claude Desktop App non trouvee"
    exit 1
}

Write-Output "=== Claude Desktop App trouvee ==="
Write-Output "PID: $($claudeProc.Id)"
Write-Output "Title: $($claudeProc.MainWindowTitle)"
Write-Output ""

$hwnd = $claudeProc.MainWindowHandle
if ($hwnd -eq [IntPtr]::Zero) {
    Write-Output "ERROR: Pas de handle de fenetre"
    exit 1
}

# Obtenir l'element racine
$root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)

if (-not $root) {
    Write-Output "ERROR: Impossible d'obtenir l'element Automation"
    exit 1
}

Write-Output "=== Exploration de l'arborescence UI ==="
Write-Output ""

# Fonction recursive pour explorer l'arborescence
function Explore-Element {
    param (
        [System.Windows.Automation.AutomationElement]$element,
        [int]$depth = 0,
        [int]$maxDepth = 4
    )

    if ($depth -gt $maxDepth) { return }

    $indent = "  " * $depth

    try {
        $name = $element.Current.Name
        $controlType = $element.Current.ControlType.ProgrammaticName
        $automationId = $element.Current.AutomationId
        $className = $element.Current.ClassName
        $isEnabled = $element.Current.IsEnabled
        $hasKeyboard = $element.Current.HasKeyboardFocus

        # Afficher les elements interessants
        $isInteresting = $controlType -match 'Tab|Button|List|Tree|Menu|Custom' -or
                         $name -match 'session|chat|conversation|history|new|projet|project' -or
                         $automationId -ne ''

        if ($isInteresting -or $depth -le 2) {
            $info = "$indent[$controlType] "
            if ($name) { $info += "Name='$name' " }
            if ($automationId) { $info += "AutomationId='$automationId' " }
            if ($className) { $info += "Class='$className' " }

            Write-Output $info
        }

        # Explorer les enfants
        $children = $element.FindAll(
            [System.Windows.Automation.TreeScope]::Children,
            [System.Windows.Automation.Condition]::TrueCondition
        )

        foreach ($child in $children) {
            Explore-Element -element $child -depth ($depth + 1) -maxDepth $maxDepth
        }
    }
    catch {
        # Ignorer les erreurs d'acces
    }
}

# Explorer depuis la racine
Explore-Element -element $root -depth 0 -maxDepth 5

Write-Output ""
Write-Output "=== Recherche specifique des elements Tab/List/Tree ==="

# Chercher specifiquement les TabItems
$tabCondition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::TabItem
)

$tabs = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tabCondition)
Write-Output "TabItems trouves: $($tabs.Count)"
foreach ($tab in $tabs) {
    Write-Output "  - TabItem: Name='$($tab.Current.Name)' AutomationId='$($tab.Current.AutomationId)'"
}

# Chercher les ListItems
$listCondition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::ListItem
)

$listItems = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $listCondition)
Write-Output ""
Write-Output "ListItems trouves: $($listItems.Count)"
foreach ($item in $listItems | Select-Object -First 20) {
    Write-Output "  - ListItem: Name='$($item.Current.Name)' AutomationId='$($item.Current.AutomationId)'"
}

# Chercher les Buttons
$buttonCondition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Button
)

$buttons = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $buttonCondition)
Write-Output ""
Write-Output "Buttons trouves: $($buttons.Count)"
foreach ($btn in $buttons | Select-Object -First 30) {
    $btnName = $btn.Current.Name
    if ($btnName) {
        Write-Output "  - Button: Name='$btnName' AutomationId='$($btn.Current.AutomationId)'"
    }
}

# Chercher les elements Custom (souvent utilises par Electron/React)
$customCondition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Custom
)

$customs = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $customCondition)
Write-Output ""
Write-Output "Custom elements avec nom: "
foreach ($custom in $customs) {
    $customName = $custom.Current.Name
    if ($customName -and $customName.Length -gt 0 -and $customName.Length -lt 100) {
        Write-Output "  - Custom: Name='$customName' AutomationId='$($custom.Current.AutomationId)'"
    }
}

Write-Output ""
Write-Output "=== Fin de l'exploration ==="
