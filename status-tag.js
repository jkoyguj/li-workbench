/* ============================================================
   StatusTag · 状态标签 / 优先级标签渲染助手 v1.1（零依赖）
   ------------------------------------------------------------
   配套 status-badge.css 一起使用。

   API 一览：
     StatusTag.html(status, opts)         → 状态标签 HTML 字符串
     StatusTag.el(status, opts)           → 状态标签 DOM 元素
     StatusTag.render(container, ...)     → 直接渲染状态标签进容器
     StatusTag.picker(opts)               → 状态选择器按钮组

     StatusTag.priority(key, opts)        → 优先级标签 HTML 字符串（新增）
     StatusTag.priorityEl(key, opts)      → 优先级标签 DOM 元素
     StatusTag.priorityPicker(opts)       → 优先级选择器按钮组（新增）

     StatusTag.STATUS                     → 状态配置表
     StatusTag.PRIORITY                   → 优先级配置表

   opts 可选项（html / priority 通用）：
     { variant: 'soft'|'outline'|'solid'|'ghost',
       size:    'xs'|'sm'|'md'|'lg',
       label:   '自定义文字',
       dot:     false,     // 不显示圆点
       pulse:   true,      // 圆点呼吸动画
       spinner: true,      // 显示加载环（进行中）
       square:  true }     // 方角（优先级默认已启用）
   ============================================================ */

window.StatusTag = (function () {
  'use strict';

  /* 基础默认值 */
  var BASE = { variant: 'soft', size: 'md', dot: true, pulse: false, spinner: false, square: false };

  /* ----------------------------------------------------------
     状态配置表 —— 业务状态都在这里定义。
     新增状态只需要加一行，例如：
       blocked: { label: '受阻', type: 'err' }
     type 可选：success | info | warn | err | neutral | violet | teal
     variant 可选：soft（默认）| outline | solid | ghost
     pulse: true 表示圆点带呼吸动画
     ---------------------------------------------------------- */
  var STATUS = {
    todo:    { label: '待处理', type: 'warn' },        // 琥珀色
    doing:   { label: '进行中', type: 'info', pulse: true },
    delayed: { label: '已延期', type: 'err' },         // 红色
    done:    { label: '已完成', type: 'success' }
  };

  /* ----------------------------------------------------------
     优先级配置表（新增）
     默认全部使用柔和填充（soft），与状态标签风格保持一致：
     P0 浅红底深红字 / P1 浅琥珀底深琥珀字 / P2 浅灰底深灰字 / P3 幽灵灰。
     想要更醒目，可把 variant 改回 'solid'。
     ---------------------------------------------------------- */
  var PRIORITY = {
    p0: { label: 'P0', color: 'err',     variant: 'soft' },
    p1: { label: 'P1', color: 'warn',    variant: 'soft' },
    p2: { label: 'P2', color: 'neutral', variant: 'soft' },
    p3: { label: 'P3', color: 'neutral', variant: 'ghost' }
  };

  /* HTML 转义 */
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* 对象浅合并：defaults ← overrides */
  function extend(defaults, overrides) {
    var out = {};
    for (var k in defaults) out[k] = defaults[k];
    for (var k in overrides) {
      if (overrides && overrides[k] !== undefined) out[k] = overrides[k];
    }
    return out;
  }

  /* 统一渲染标签 */
  function buildTag(type, overrides) {
    var o = extend(BASE, overrides || {});

    var cls = 'sb-tag sb-tag--' + type;
    if (o.variant && o.variant !== 'soft') cls += ' sb-tag--' + o.variant;
    if (o.size && o.size !== 'md')         cls += ' sb-tag--' + o.size;
    if (o.square)                          cls += ' sb-tag--square';

    var indicator = '';
    if (o.spinner) {
      indicator = '<span class="sb-spinner"></span>';
    } else if (o.dot) {
      indicator = '<i class="sb-dot sb-dot--' + type + (o.pulse ? ' sb-dot--pulse' : '') + '"></i>';
    }
    return '<span class="' + cls + '">' + indicator + esc(o.label || '') + '</span>';
  }

  /**
   * 生成状态标签 HTML
   * @param {string} status - 状态 key，见 STATUS 表
   * @param {object} [opts]
   * @returns {string}
   */
  function html(status, opts) {
    var conf = STATUS[status] || { label: String(status), type: 'neutral' };
    var defaults = {
      label:   conf.label,
      variant: conf.variant || BASE.variant,
      pulse:   !!conf.pulse,
      dot:     true,
      square:  false
    };
    return buildTag(conf.type, extend(defaults, opts || {}));
  }

  function el(status, opts) {
    var t = document.createElement('template');
    t.innerHTML = html(status, opts);
    return t.content.firstElementChild;
  }

  function render(container, status, opts) {
    if (container) container.innerHTML = html(status, opts);
  }

  /**
   * 生成优先级标签 HTML
   * @param {string} key - 优先级 key，见 PRIORITY 表
   * @param {object} [opts]
   * @returns {string}
   */
  function priority(key, opts) {
    var conf = PRIORITY[key] || { label: String(key).toUpperCase(), color: 'neutral', variant: 'soft' };
    var defaults = {
      label:   conf.label,
      variant: conf.variant,
      dot:     false,
      square:  false   // 默认胶囊形，和状态标签风格一致
    };
    return buildTag(conf.color, extend(defaults, opts || {}));
  }

  function priorityEl(key, opts) {
    var t = document.createElement('template');
    t.innerHTML = priority(key, opts);
    return t.content.firstElementChild;
  }

  function priorityRender(container, key, opts) {
    if (container) container.innerHTML = priority(key, opts);
  }

  /* 通用选择器工厂 */
  function makePicker(items, opts, renderItem) {
    opts = opts || {};
    var keys = opts.items || Object.keys(items);
    var wrap = document.createElement('div');
    wrap.className = 'sb-picker';
    wrap.setAttribute('role', 'radiogroup');

    keys.forEach(function (k) {
      var conf = items[k];
      var built = renderItem(conf, k, opts.value === k);
      var b = document.createElement('button');
      b.type = 'button';
      b.className = built.className;
      b.innerHTML = built.innerHTML;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', k === opts.value ? 'true' : 'false');
      b.dataset.value = k;

      b.addEventListener('click', function () {
        wrap.querySelectorAll('.is-active').forEach(function (x) {
          x.classList.remove('is-active');
          x.setAttribute('aria-checked', 'false');
        });
        b.classList.add('is-active');
        b.setAttribute('aria-checked', 'true');
        wrap.value = k;
        if (typeof opts.onChange === 'function') opts.onChange(k);
      });

      wrap.appendChild(b);
    });

    wrap.value = opts.value || keys[0];
    return wrap;
  }

  /**
   * 状态选择器
   * @param {object} [opts]
   *   - value:     初始选中的状态 key
   *   - statuses:  要展示的状态 key 数组，默认全部
   *   - onChange:  function(statusKey)
   * @returns {HTMLElement}
   */
  function picker(opts) {
    opts = opts || {};
    return makePicker(STATUS, { items: opts.statuses, value: opts.value, onChange: opts.onChange }, function (conf, k, active) {
      var cls = 'sb-tag sb-tag--' + conf.type + (active ? ' is-active' : '');
      var dot = '<i class="sb-dot sb-dot--' + conf.type + '"></i>';
      return { className: cls, innerHTML: dot + esc(conf.label) };
    });
  }

  /**
   * 优先级选择器
   * @param {object} [opts]
   *   - value:       初始选中的优先级 key，默认 'p2'
   *   - priorities:  要展示的优先级 key 数组，默认全部
   *   - onChange:    function(priorityKey)
   * @returns {HTMLElement}
   */
  function priorityPicker(opts) {
    opts = opts || {};
    if (!opts.value) opts.value = 'p2';
    return makePicker(PRIORITY, { items: opts.priorities, value: opts.value, onChange: opts.onChange }, function (conf, k, active) {
      var cls = 'sb-tag sb-tag--' + conf.color + ' sb-tag--' + conf.variant + (active ? ' is-active' : '');
      return { className: cls, innerHTML: esc(conf.label) };
    });
  }

  /* 导出 */
  return {
    html:     html,
    el:       el,
    render:   render,
    picker:   picker,

    priority:       priority,
    priorityEl:     priorityEl,
    priorityRender: priorityRender,
    priorityPicker: priorityPicker,

    STATUS:   STATUS,
    PRIORITY: PRIORITY,
    esc:      esc
  };
})();
