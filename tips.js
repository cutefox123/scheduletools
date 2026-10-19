// 贴心提醒：从 Android 版 TipsEngine.java 逐条移植
// 纯规则、离线可用。输入 = 某天的班次（parser.js 产出）+ 结构化天气（weather.js 产出）。

import { dayWorkTimes, morningHasShift, nightHasDaytimeHalf } from './parser.js?v=2026-10-19T10%3A46%3A57';

function typeOfShift(d) {
  return d.type || 'REST';
}

/**
 * @param {object} d  DayShift 形态：{ type, startTime, raw, ymd }
 * @param {object|null} w 结构化天气：{ type, high, low, wind, windLevel, notice }
 * @returns {string} 多行文本（每行以「• 」开头），与安卓版一致
 */
export function buildTips(d, w) {
  const tips = [];
  const MIN = -999;

  let rain = false;
  let heavyRain = false;
  let snow = false;
  let fog = false;
  let haze = false;
  let sunny = false;
  if (w && w.type) {
    const t = w.type;
    heavyRain = t.includes('暴雨') || t.includes('大雨') || t.includes('大到') || t.includes('雨夹雪');
    rain = heavyRain || t.includes('雨') || t.includes('阵雨') || t.includes('雷阵');
    snow = (t.includes('雪') && !t.includes('雨夹雪')) || (heavyRain && t.includes('雪'));
    fog = t.includes('雾');
    haze = t.includes('霾') || t.includes('沙');
    sunny = t.includes('晴');
  }

  // ---- 天气类 ----
  if (heavyRain) {
    tips.push('有明显降雨：穿雨衣比打伞更稳妥，路面湿滑，骑车开车放慢速度，提前10分钟出门');
  } else if (rain) {
    tips.push('有小雨：记得带伞，路面湿滑，路上多留几分钟');
  }
  if (snow) {
    tips.push('有雪：穿防滑鞋，注意脚下保暖，出行小心慢走');
  }
  if (fog) {
    tips.push('有雾能见度低：骑车开车慢行、保持车距，过马路注意安全');
  }
  if (haze) {
    tips.push('空气不好：戴好口罩，户外少逗留');
  }
  if (w && w.high != null && w.high > MIN) {
    if (w.high >= 35) {
      tips.push('高温' + w.high + '℃：多喝水防暑，门诊/病房空调凉，备件薄外套');
    } else if (w.high >= 32) {
      tips.push('天气偏热：注意补水，出门可以戴个遮阳帽');
    }
    if (w.low != null && w.low <= 0) {
      tips.push('最低' + w.low + '℃：严寒，羽绒服、手套帽子都安排上');
    } else if (w.low != null && w.low <= 6) {
      tips.push('早晚只有' + w.low + '℃：多穿一件，注意保暖别感冒');
    }
    if (w.low != null && w.low > MIN && w.high - w.low >= 10) {
      tips.push('昼夜温差' + (w.high - w.low) + '℃：早晚加件外套，洋葱式穿衣');
    }
  }
  if (w && w.windLevel != null && w.windLevel >= 5) {
    tips.push((w.wind || '') + '风较大：远离广告牌和临时搭建物，骑行注意侧风');
  } else if (w && w.windLevel != null && w.windLevel >= 4) {
    tips.push((w.wind || '') + '：出门整理好衣帽，风大骑车放慢些');
  }
  if (sunny && w && w.high != null && w.high >= 28) {
    tips.push('阳光强：涂防晒或戴帽子，谨防紫外线');
  }

  // ---- 班次类 ----
  const type = typeOfShift(d);
  if (type === 'DAY') {
    const start = d.startTime ? d.startTime : '07:30';
    tips.push(start + '上班：到点通知响了别赖床；中午尽量眯一会儿，下午更有精神');
  } else if (type === 'MID') {
    const range = dayWorkTimes(d.raw, d.ymd);
    tips.push('中班 ' + (range ? range : '12:00-13:30')
      + '：中午连班，接班前先吃口热饭垫一垫，别空着肚子上班');
    tips.push(morningHasShift(d.raw)
      ? '上午还有半天班，连到中班结束会比较累，中间抓紧歇十几分钟'
      : '上午可以安心补个觉，但记得定好闹钟，别睡过头耽误 12:00 接班');
  } else if (type === 'NIGHT') {
    const start = d.startTime ? d.startTime : '17:30';
    tips.push(start + '接班到明早07:30：备件薄外套（后半夜凉）、带杯热水或咖啡和小零食；凌晨困了起来走两步，交班前清点好工作');
    tips.push(nightHasDaytimeHalf(d.raw)
      ? '白天还有半天班，下占到接班前抓紧眯一会儿，接班前会再提醒你'
      : '白天先补一觉养足精神，接班前会再提醒你，别睡过头');
  } else if (type === 'OFF_NIGHT') {
    tips.push('07:30交班后下班：回家路上注意安全，好好补觉，拉好窗帘睡得香');
  } else {
    tips.push('今天休息：睡个懒觉放松一下，记得按时吃饭');
  }

  if (w && w.notice && w.notice !== '' && tips.length < 4) {
    tips.push('气象台提示：' + w.notice);
  }

  if (!tips.length) {
    return '今天天气和班次都比较平稳，正常作息即可，出门带好工牌。';
  }
  return tips.map((t) => '• ' + t).join('\n');
}
