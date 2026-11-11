# Organizing pages

Page commands change the open document. Save the file to keep the changes. See [Saving, recovery and file safety](saving-recovery-and-file-safety.md).

## Where the commands are

- **Pages group in the toolbar:** Insert, Delete, Rotate, Crop, Page size and More (…).
- **Menu:** the **Pages** menu has the same commands, in the same order.
- **Thumbnails panel:** a row of buttons and a right-click menu.
- **Right-click on a page:** a **Pages** submenu.
- **Command palette:** press **Ctrl+K** and type "Pages:" to find each command.

Commands that cannot be used right now are greyed out. They show a reason in the tooltip.

## Insert pages

- **Menu:** Pages ▸ **Insert** ▸ **Blank**, **Lined**, **Grid** or **From PDF…**
- **Toolbar:** Insert, then pick the kind of page.

The Insert panel opens at the right side of the window. It has these settings:

| Setting | Choices | Default |
|---|---|---|
| Type | Blank, Lined, Grid | Blank |
| Size | Letter, A4, Legal, Custom | Letter |
| Count | a number | 1 |
| Position | Before, After, At page number | After the current page |

For **From PDF…**, choose the file, type the page range (for example, `1-5, 8`), and choose the position.

Choose **Apply** to add the pages, or **Cancel** to stop. **Esc** also cancels.

A toast says "Inserted 2 blank pages · Undo" (the number changes).

## Delete pages

- **Keyboard:** **Delete**
- **Menu:** Pages ▸ **Delete**
- **Toolbar:** Delete

The toast says "Deleted 3 pages · Undo". If you delete more than half of the pages, the panel asks you to confirm first.

## Duplicate, replace, reverse and extract

These four commands are in the **More (…)** menu.

- **Duplicate:** copies the selected pages. **Ctrl+D** does the same.
- **Replace:** choose a source file and a page. The page from that file replaces the selected page.
- **Reverse:** reverses the order of the pages.
- **Extract:** saves the selected pages as a new file. It opens the Save dialog with the name "<name>-extract.pdf". The original file does not change.

## Rotate

- **Keyboard:** **Ctrl+Shift+R** rotates right by 90 degrees. **Ctrl+Shift+L** rotates left.
- **Toolbar:** Rotate. Its arrow lists Left 90, 180 and Custom angle.
- **Custom angle:** the Rotate panel has a slider from −45 to +45 degrees, in steps of 0.1, and a box where you can type the number. The panel shows a preview.

## Crop

- **Toolbar:** Crop, then **Crop pages…** or **Auto-crop**.
- **Crop pages…** shows a box on the page with eight handles. You can also type margins for top, bottom, left and right, in inches, millimetres or points.
- **Apply to:** Current, Selected, All, Odd or Even.
- **Auto-crop** removes white space around the content, and shows a preview first.

## Page size

- **Toolbar:** Page size…
- Choose **Letter**, **A4** or **Custom**.
- Choose **Scale to fit** or **Center**.
- Apply to the **Selected** pages or to **All** pages.

## Move pages

- **Drag:** drag thumbnails. An accent line shows where the pages will go. The list scrolls when you drag near its top or bottom edge.
- **Keyboard:** select a page, then press **Alt+Up** or **Alt+Down**.

## Undo

Each change can be undone. Undo and Redo have names, for example "Undo Delete 3 pages". They are in the File group, and under Edit.

- **Undo:** **Ctrl+Z**
- **Redo:** **Ctrl+Y** or **Ctrl+Shift+Z**

## Progress for large changes

For changes over 100 pages, or changes that take more than 2 seconds, a progress bar appears in the status bar. You can choose **Cancel**.

## Messages

| Message | What it means |
|---|---|
| Deleted 3 pages · Undo | The pages were deleted. Click Undo to bring them back. |
| Inserted 2 blank pages · Undo | Blank pages were added. |
| This form can be viewed but not edited yet. | The file is an XFA form. Page commands are off for it. |
