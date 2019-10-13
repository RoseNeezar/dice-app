import 'package:flutter/material.dart';
import 'dart:math';

void main() {
  return runApp(
    MaterialApp(
      home: Scaffold(
        backgroundColor: Colors.red,
        appBar: AppBar(
          title: Text('Dicee'),
          backgroundColor: Colors.red,
        ),
        body: DicePage(),
      ),
    ),
  );
}

class DicePage extends StatefulWidget {
  @override
  _DicePageState createState() => _DicePageState();
}

class _DicePageState extends State<DicePage> {
  int temp = 1;
  int temp1 = 1;
  @override
  Widget build(BuildContext context) {
    return Center(
      child: Row(
        children: <Widget>[
          Expanded(
            child: FlatButton(
              onPressed: () {
                setState(() {
                  temp = new Random().nextInt(6) + 1;
                  print('left = $temp');
                });
              },
              child: Image.asset('images/dice$temp.png'),
            ),
          ),
          Expanded(
            child: FlatButton(
              onPressed: () {
                setState(() {
                  temp1 = new Random().nextInt(6) + 1;
                  print('right = $temp1');
                });
              },
              child: Image.asset('images/dice$temp1.png'),
            ),
          ),
        ],
      ),
    );
  }
}
